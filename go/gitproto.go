// Git smart HTTP: pkt-lines, protocol v0/v2 advertisements, ls-refs, fetch
// and receive-pack. Derived from the kit's wire spec (git-client.ts and
// checks-git.ts), not from any prior implementation.

package main

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// --- pkt-lines ---

// pktLine frames one payload: a 4-hex length (including the header) plus the
// payload bytes. Payloads over 65516 bytes must be split by the caller.
func pktLine(payload []byte) []byte {
	out := make([]byte, 4+len(payload))
	n := len(payload) + 4
	hexDigits := "0123456789abcdef"
	out[0] = hexDigits[(n>>12)&0xf]
	out[1] = hexDigits[(n>>8)&0xf]
	out[2] = hexDigits[(n>>4)&0xf]
	out[3] = hexDigits[n&0xf]
	copy(out[4:], payload)
	return out
}

var pktFlush = []byte("0000")
var pktDelim = []byte("0001")

type pktKind int

const (
	pktData pktKind = iota
	pktFlushKind
	pktDelimKind
	pktEndKind
)

type pkt struct {
	kind    pktKind
	payload []byte
}

// parsePktLines splits a byte stream into packets. A length of 3 or a length
// past the end of the buffer is malformed.
func parsePktLines(data []byte) ([]pkt, error) {
	var out []pkt
	off := 0
	for off < len(data) {
		if len(data)-off < 4 {
			return nil, fmt.Errorf("pkt-line header truncated at offset %d", off)
		}
		header := string(data[off : off+4])
		n, err := strconv.ParseUint(header, 16, 32)
		if err != nil {
			return nil, fmt.Errorf("pkt-line header %q is not hex", header)
		}
		switch n {
		case 0:
			out = append(out, pkt{kind: pktFlushKind})
			off += 4
			continue
		case 1:
			out = append(out, pkt{kind: pktDelimKind})
			off += 4
			continue
		case 2:
			out = append(out, pkt{kind: pktEndKind})
			off += 4
			continue
		case 3:
			return nil, fmt.Errorf("pkt-line length 3 is invalid")
		}
		if n > 65520 {
			return nil, fmt.Errorf("pkt-line length %d exceeds the maximum", n)
		}
		if off+int(n) > len(data) {
			return nil, fmt.Errorf("pkt-line of length %d runs past the body", n)
		}
		out = append(out, pkt{kind: pktData, payload: data[off+4 : off+int(n)]})
		off += int(n)
	}
	return out, nil
}

// --- path handling ---

// parseGitPath splits "/{owner}/{repo}.git/{rest...}".
func parseGitPath(path string) (owner, repo, rest string, ok bool) {
	segments := strings.Split(path, "/")
	if len(segments) < 3 || segments[0] != "" || segments[1] == "" {
		return "", "", "", false
	}
	repoGit := segments[2]
	if !strings.HasSuffix(repoGit, ".git") || len(repoGit) <= 4 {
		return "", "", "", false
	}
	return segments[1], repoGit[:len(repoGit)-4], strings.Join(segments[3:], "/"), true
}

// --- advertisements ---

// v2Advertisement is constant: the protocol-2 capability list never depends
// on repo state.
func v2Advertisement() []byte {
	var buf bytes.Buffer
	buf.Write(pktLine([]byte("version 2")))
	buf.Write(pktLine([]byte("ls-refs=unborn")))
	buf.Write(pktLine([]byte("fetch=shallow")))
	buf.Write(pktLine([]byte("agent=forge/1.0")))
	buf.Write(pktLine([]byte("object-format=sha1")))
	buf.Write(pktFlush)
	return buf.Bytes()
}

var v2AdvertisementBytes = v2Advertisement()

func sortedRefNames(r *Repo) []string {
	names := make([]string, 0, len(r.Refs))
	for name := range r.Refs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// v0UploadAdvertisement builds the upload-pack v0 advertisement: the service
// preamble, a HEAD line when the default branch exists (carrying the caps),
// ref lines, and peeled-tag lines.
func v0UploadAdvertisement(r *Repo) []byte {
	caps := "multi_ack thin-pack side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main"
	var buf bytes.Buffer
	buf.Write(pktLine([]byte("# service=git-upload-pack")))
	buf.Write(pktFlush)
	names := sortedRefNames(r)
	first := true
	writeLine := func(oid, ref string) {
		line := oid + " " + ref
		if first {
			line += "\x00" + caps
			first = false
		}
		buf.Write(pktLine([]byte(line)))
	}
	if tip, ok := r.branchTip(r.DefaultBranch); ok {
		writeLine(tip, "HEAD")
	}
	if len(names) == 0 {
		writeLine(zeroOID, "capabilities^{}")
	}
	for _, name := range names {
		oid := r.Refs[name]
		writeLine(oid, name)
		if peeled, isTag := r.peelTag(oid); isTag {
			writeLine(peeled, name+"^{}")
		}
	}
	buf.Write(pktFlush)
	return buf.Bytes()
}

// v0ReceiveAdvertisement builds the receive-pack v0 advertisement: the service
// preamble and ref lines only (no HEAD line), caps on the first line.
func v0ReceiveAdvertisement(r *Repo) []byte {
	caps := "report-status side-band-64k delete-refs"
	var buf bytes.Buffer
	buf.Write(pktLine([]byte("# service=git-receive-pack")))
	buf.Write(pktFlush)
	names := sortedRefNames(r)
	first := true
	writeLine := func(oid, ref string) {
		line := oid + " " + ref
		if first {
			line += "\x00" + caps
			first = false
		}
		buf.Write(pktLine([]byte(line)))
	}
	if len(names) == 0 {
		writeLine(zeroOID, "capabilities^{}")
	}
	for _, name := range names {
		writeLine(r.Refs[name], name)
	}
	buf.Write(pktFlush)
	return buf.Bytes()
}

// --- ls-refs ---

type lsRefsArgs struct {
	peel     bool
	symrefs  bool
	unborn   bool
	prefixes []string
}

func (a lsRefsArgs) key() string {
	return fmt.Sprintf("peel=%v symrefs=%v unborn=%v prefixes=%s", a.peel, a.symrefs, a.unborn, strings.Join(a.prefixes, "\x00"))
}

func (a lsRefsArgs) matches(ref string) bool {
	if len(a.prefixes) == 0 {
		return true
	}
	for _, p := range a.prefixes {
		if strings.HasPrefix(ref, p) {
			return true
		}
	}
	return false
}

// lsRefsResponse builds the ls-refs answer: one line per matching ref, HEAD
// first, sorted by ref name.
func lsRefsResponse(r *Repo, args lsRefsArgs) []byte {
	type line struct {
		ref  string
		text string
	}
	var lines []line
	if args.matches("HEAD") && (args.symrefs || args.unborn) {
		if tip, ok := r.branchTip(r.DefaultBranch); ok {
			text := tip + " HEAD"
			if args.symrefs {
				text += " symref-target:refs/heads/" + r.DefaultBranch
			}
			lines = append(lines, line{"HEAD", text})
		} else {
			text := "unborn HEAD"
			if args.symrefs {
				text += " symref-target:refs/heads/" + r.DefaultBranch
			}
			lines = append(lines, line{"HEAD", text})
		}
	}
	for _, name := range sortedRefNames(r) {
		if !args.matches(name) {
			continue
		}
		oid := r.Refs[name]
		text := oid + " " + name
		if args.peel {
			if peeled, isTag := r.peelTag(oid); isTag {
				text += " peeled:" + peeled
			}
		}
		lines = append(lines, line{name, text})
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].ref < lines[j].ref })
	var buf bytes.Buffer
	for _, l := range lines {
		buf.Write(pktLine([]byte(l.text)))
	}
	buf.Write(pktFlush)
	return buf.Bytes()
}

// --- fetch planning ---

type fetchArgs struct {
	wants     []string
	haves     []string
	shallow   []string // client-declared shallow boundary commits
	depth     int      // 0 = no depth limit
	deepenNot []string // ref names whose tips the client already holds
}

func (a fetchArgs) key(protocol string) string {
	wants := append([]string(nil), a.wants...)
	haves := append([]string(nil), a.haves...)
	shallow := append([]string(nil), a.shallow...)
	sort.Strings(wants)
	sort.Strings(haves)
	sort.Strings(shallow)
	return protocol + "\x00" + strings.Join(wants, ",") + "\x00" + strings.Join(haves, ",") +
		"\x00" + strings.Join(shallow, ",") + "\x00" + strconv.Itoa(a.depth) +
		"\x00" + strings.Join(a.deepenNot, ",")
}

// commitClosure walks from wants to commits, recording generations. Tag
// objects on the path are collected separately. Depth 0 means unlimited.
func (r *Repo) commitClosure(wants []string, depth int) (map[string]int, []string, []string) {
	generations := map[string]int{}
	var tags []string
	var nonCommits []string
	type item struct {
		oid string
		gen int
	}
	queue := []item{}
	for _, want := range wants {
		oid := want
		for {
			obj := r.Objects[oid]
			if obj == nil {
				break
			}
			if obj.Type == "tag" {
				tags = append(tags, oid)
				target, _, ok := parseTagObject(obj.Data)
				if !ok {
					break
				}
				oid = target
				continue
			}
			break
		}
		if r.commitInfo(oid) != nil {
			queue = append(queue, item{oid, 1})
		} else if _, ok := r.Objects[oid]; ok {
			nonCommits = append(nonCommits, want)
		}
		// Missing wants are skipped leniently.
	}
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		if prev, ok := generations[it.oid]; ok && prev <= it.gen {
			continue
		}
		generations[it.oid] = it.gen
		if depth > 0 && it.gen >= depth {
			continue
		}
		if ci := r.commitInfo(it.oid); ci != nil {
			for _, p := range ci.Parents {
				queue = append(queue, item{p, it.gen + 1})
			}
		}
	}
	return generations, tags, nonCommits
}

// heldObjects returns everything the client already has: the closure of the
// haves, with parent traversal stopped at declared shallow-boundary commits
// (the boundary commit and its tree are held; its parents are not).
func (r *Repo) heldObjects(haves []string, boundary map[string]bool) map[string]bool {
	held := map[string]bool{}
	var stack []string
	stack = append(stack, haves...)
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if held[oid] || !isOID(oid) {
			continue
		}
		obj := r.Objects[oid]
		if obj == nil {
			continue
		}
		held[oid] = true
		switch obj.Type {
		case "commit":
			if ci := r.commitInfo(oid); ci != nil {
				stack = append(stack, ci.Tree)
				if !boundary[oid] {
					stack = append(stack, ci.Parents...)
				}
			}
		case "tag":
			if target, _, ok := parseTagObject(obj.Data); ok {
				stack = append(stack, target)
			}
		case "tree":
			for _, e := range r.treeEntries(oid) {
				if e.Mode != "160000" {
					stack = append(stack, e.OID)
				}
			}
		}
	}
	return held
}

type fetchPlan struct {
	sendOIDs  []string // sorted
	shallow   []string
	unshallow []string
	acks      []string
	nak       bool
}

// planFetch computes the object set and the shallow/ack lines for a fetch.
func (r *Repo) planFetch(args fetchArgs) *fetchPlan {
	boundary := map[string]bool{}
	for _, s := range args.shallow {
		boundary[s] = true
	}
	heldRoots := append([]string(nil), args.haves...)
	for _, ref := range args.deepenNot {
		if oid, ok := r.resolveRef(ref); ok {
			heldRoots = append(heldRoots, oid)
		}
	}
	held := r.heldObjects(heldRoots, boundary)

	generations, tags, nonCommits := r.commitClosure(args.wants, args.depth)

	wantObjects := map[string]bool{}
	for _, tagOID := range tags {
		wantObjects[tagOID] = true
	}
	for oid := range generations {
		wantObjects[oid] = true
		ci := r.commitInfo(oid)
		if ci != nil {
			for treeOID := range r.collectReachable([]string{ci.Tree}) {
				wantObjects[treeOID] = true
			}
		}
	}
	for _, oid := range nonCommits {
		for reachable := range r.collectReachable([]string{oid}) {
			wantObjects[reachable] = true
		}
	}

	plan := &fetchPlan{}
	for oid := range wantObjects {
		if !held[oid] {
			plan.sendOIDs = append(plan.sendOIDs, oid)
		}
	}
	sort.Strings(plan.sendOIDs)

	// Shallow boundary: commits at the depth limit that still have parents
	// outside the wanted set.
	if args.depth > 0 {
		for oid, gen := range generations {
			if gen != args.depth {
				continue
			}
			ci := r.commitInfo(oid)
			if ci == nil {
				continue
			}
			for _, p := range ci.Parents {
				if _, inSet := generations[p]; !inSet {
					plan.shallow = append(plan.shallow, oid)
					break
				}
			}
		}
		sort.Strings(plan.shallow)
	}
	// Unshallow: old boundary commits now fully inside the wanted set.
	for _, old := range args.shallow {
		if _, inSet := generations[old]; !inSet {
			continue
		}
		ci := r.commitInfo(old)
		if ci == nil {
			continue
		}
		allIn := true
		for _, p := range ci.Parents {
			if _, inSet := generations[p]; !inSet {
				allIn = false
				break
			}
		}
		if allIn {
			plan.unshallow = append(plan.unshallow, old)
		}
	}
	sort.Strings(plan.unshallow)

	// Acknowledgments: ACK every have present in the store, else NAK.
	if len(args.haves) > 0 {
		for _, have := range args.haves {
			if _, ok := r.Objects[have]; ok {
				plan.acks = append(plan.acks, have)
			}
		}
		if len(plan.acks) == 0 {
			plan.nak = true
		}
	}
	return plan
}

// packBytesFor renders the fetch pack: the planned objects, sorted by oid,
// as plain (undeltified) pack entries.
func (r *Repo) packBytesFor(plan *fetchPlan) []byte {
	objects := make([]*Object, 0, len(plan.sendOIDs))
	for _, oid := range plan.sendOIDs {
		if obj := r.Objects[oid]; obj != nil {
			objects = append(objects, obj)
		}
	}
	return writePack(objects)
}

// writeSideband appends the pack as band-1 sideband packets (32 KiB chunks).
func writeSideband(buf *bytes.Buffer, pack []byte) {
	const chunk = 32768
	for off := 0; off < len(pack); off += chunk {
		end := off + chunk
		if end > len(pack) {
			end = len(pack)
		}
		packet := make([]byte, 1+end-off)
		packet[0] = 1
		copy(packet[1:], pack[off:end])
		buf.Write(pktLine(packet))
	}
	if len(pack) == 0 {
		// An empty pack is still 32 bytes; this branch is unreachable, but
		// the packfile section must never be empty.
		buf.Write(pktLine([]byte{1}))
	}
}

// fetchResponseV2 renders the v2 fetch answer: acknowledgments, shallow-info
// and packfile sections, in that order, separated by delim packets. Section
// headers and their lines carry the trailing newline the wire format uses.
func fetchResponseV2(r *Repo, args fetchArgs) []byte {
	plan := r.planFetch(args)
	pack := r.packBytesFor(plan)
	var buf bytes.Buffer
	sections := 0
	if len(args.haves) > 0 {
		buf.Write(pktLine([]byte("acknowledgments\n")))
		if plan.nak {
			buf.Write(pktLine([]byte("NAK\n")))
		}
		for _, ack := range plan.acks {
			buf.Write(pktLine([]byte("ACK " + ack + "\n")))
		}
		sections++
	}
	if len(plan.shallow) > 0 || len(plan.unshallow) > 0 {
		if sections > 0 {
			buf.Write(pktDelim)
		}
		buf.Write(pktLine([]byte("shallow-info\n")))
		for _, s := range plan.shallow {
			buf.Write(pktLine([]byte("shallow " + s + "\n")))
		}
		for _, s := range plan.unshallow {
			buf.Write(pktLine([]byte("unshallow " + s + "\n")))
		}
		sections++
	}
	if sections > 0 {
		buf.Write(pktDelim)
	}
	buf.Write(pktLine([]byte("packfile\n")))
	writeSideband(&buf, pack)
	buf.Write(pktFlush)
	return buf.Bytes()
}

// fetchResponseV0 renders the v0 fetch answer: plain-text shallow/ack lines,
// then the pack as sideband band-1 packets, then flush.
func fetchResponseV0(r *Repo, args fetchArgs) []byte {
	plan := r.planFetch(args)
	pack := r.packBytesFor(plan)
	var buf bytes.Buffer
	for _, s := range plan.shallow {
		buf.Write(pktLine([]byte("shallow " + s + "\n")))
	}
	for _, s := range plan.unshallow {
		buf.Write(pktLine([]byte("unshallow " + s + "\n")))
	}
	if len(plan.acks) > 0 {
		for _, ack := range plan.acks {
			buf.Write(pktLine([]byte("ACK " + ack + "\n")))
		}
	} else {
		buf.Write(pktLine([]byte("NAK\n")))
	}
	writeSideband(&buf, pack)
	buf.Write(pktFlush)
	return buf.Bytes()
}

// --- v2 request parsing ---

// parseV2Command splits a v2 request body into the command, the pre-delim
// arguments and the post-delim arguments.
func parseV2Command(body []byte) (command string, pre, post []string, err error) {
	packets, err := parsePktLines(body)
	if err != nil {
		return "", nil, nil, err
	}
	seenDelim := false
	for _, p := range packets {
		switch p.kind {
		case pktFlushKind, pktEndKind:
			// End of the request.
		case pktDelimKind:
			seenDelim = true
		case pktData:
			// Request lines carry a trailing newline inside the packet.
			line := strings.TrimSuffix(string(p.payload), "\n")
			if command == "" && strings.HasPrefix(line, "command=") {
				command = line[len("command="):]
				continue
			}
			if seenDelim {
				post = append(post, line)
			} else {
				pre = append(pre, line)
			}
		}
	}
	if command == "" {
		return "", nil, nil, fmt.Errorf("v2 request carries no command=")
	}
	return command, pre, post, nil
}

func parseLsRefsArgs(post []string) lsRefsArgs {
	var args lsRefsArgs
	for _, line := range post {
		switch {
		case line == "peel":
			args.peel = true
		case line == "symrefs":
			args.symrefs = true
		case line == "unborn":
			args.unborn = true
		case strings.HasPrefix(line, "ref-prefix "):
			args.prefixes = append(args.prefixes, line[len("ref-prefix "):])
		}
	}
	return args
}

func parseFetchArgsV2(post []string) fetchArgs {
	var args fetchArgs
	for _, line := range post {
		switch {
		case strings.HasPrefix(line, "want "):
			args.wants = append(args.wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			args.haves = append(args.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			args.shallow = append(args.shallow, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			if n, err := strconv.Atoi(strings.TrimSpace(line[7:])); err == nil && n > 0 {
				args.depth = n
			}
		case strings.HasPrefix(line, "deepen-not "):
			args.deepenNot = append(args.deepenNot, strings.TrimSpace(line[11:]))
		}
		// filter and deepen-since are never sent by the suite; ignoring them
		// yields the full object set, which is always a correct answer.
	}
	return args
}

// parseFetchArgsV0 parses a v0 fetch body: wants (with optional caps after
// NUL on the first line), shallow/deepen lines, flush, haves, done, flush.
func parseFetchArgsV0(body []byte) (fetchArgs, error) {
	var args fetchArgs
	packets, err := parsePktLines(body)
	if err != nil {
		return args, err
	}
	for _, p := range packets {
		if p.kind != pktData {
			continue
		}
		line := string(p.payload)
		if nul := strings.IndexByte(line, 0); nul >= 0 {
			line = line[:nul]
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		// The first want line carries capabilities space-separated
		// after the oid; every line's argument is its second field.
		switch fields[0] {
		case "want":
			if len(fields) >= 2 {
				args.wants = append(args.wants, fields[1])
			}
		case "have":
			if len(fields) >= 2 {
				args.haves = append(args.haves, fields[1])
			}
		case "shallow":
			if len(fields) >= 2 {
				args.shallow = append(args.shallow, fields[1])
			}
		case "deepen":
			if len(fields) >= 2 {
				if n, err := strconv.Atoi(fields[1]); err == nil && n > 0 {
					args.depth = n
				}
			}
		case "deepen-not":
			if len(fields) >= 2 {
				args.deepenNot = append(args.deepenNot, fields[1])
			}
		}
	}
	return args, nil
}

// --- receive-pack ---

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

// parsePushBody splits a receive-pack POST into command lines and the raw
// pack bytes that follow the first flush packet. Returns the commands, the
// requested capabilities, and the pack bytes.
func parsePushBody(body []byte) (commands []pushCommand, caps map[string]bool, pack []byte, err error) {
	caps = map[string]bool{}
	off := 0
	first := true
	for off < len(body) {
		if len(body)-off < 4 {
			return nil, nil, nil, fmt.Errorf("push body truncated in a pkt-line header")
		}
		n, convErr := strconv.ParseUint(string(body[off:off+4]), 16, 32)
		if convErr != nil {
			return nil, nil, nil, fmt.Errorf("push body has a non-hex pkt-line header")
		}
		if n == 0 {
			// Flush: the pack follows raw.
			return commands, caps, body[off+4:], nil
		}
		if n < 4 || n > 65520 || off+int(n) > len(body) {
			return nil, nil, nil, fmt.Errorf("push body has an invalid pkt-line length %d", n)
		}
		line := string(body[off+4 : off+int(n)])
		off += int(n)
		line = strings.TrimSuffix(line, "\n")
		if first {
			first = false
			if nul := strings.IndexByte(line, 0); nul >= 0 {
				for _, cap := range strings.Fields(line[nul+1:]) {
					name := cap
					if eq := strings.IndexByte(cap, '='); eq >= 0 {
						name = cap[:eq]
					}
					caps[name] = true
				}
				line = line[:nul]
			}
		}
		fields := strings.Fields(line)
		if len(fields) != 3 {
			return nil, nil, nil, fmt.Errorf("push command %q does not have three fields", line)
		}
		commands = append(commands, pushCommand{oldOID: fields[0], newOID: fields[1], ref: fields[2]})
	}
	// No flush packet: treat the whole body as commands and no pack.
	return commands, caps, nil, nil
}

func validRefName(ref string) bool {
	if !strings.HasPrefix(ref, "refs/") || len(ref) > 200 || len(ref) <= 5 {
		return false
	}
	for i := 0; i < len(ref); i++ {
		c := ref[i]
		if c <= ' ' || c == 0x7f {
			return false
		}
	}
	return true
}

// applyPush stores the pack objects (even when a ref update is refused) and
// applies the commands in order, returning one report line per command.
func (r *Repo) applyPush(commands []pushCommand, pack []byte) (unpackOK bool, unpackDetail string, reports []string) {
	if len(pack) > 0 {
		objects, err := r.readPack(pack)
		if err != nil {
			for _, cmd := range commands {
				reports = append(reports, "ng "+cmd.ref+" unpack failed")
			}
			return false, err.Error(), reports
		}
		for _, obj := range objects {
			r.putObject(obj.Type, obj.Data)
		}
		r.bumpGit()
	}
	refsChanged := false
	for _, cmd := range commands {
		report := r.applyPushCommand(cmd, &refsChanged)
		reports = append(reports, report)
	}
	if refsChanged {
		r.bumpGit()
	}
	return true, "", reports
}

func (r *Repo) applyPushCommand(cmd pushCommand, refsChanged *bool) string {
	ng := func(reason string) string { return "ng " + cmd.ref + " " + reason }
	ok := func() string { return "ok " + cmd.ref }
	if !validRefName(cmd.ref) {
		return ng("invalid ref")
	}
	if !isOID(cmd.oldOID) || !isOID(cmd.newOID) {
		return ng("invalid object id")
	}
	current, exists := r.Refs[cmd.ref]
	if !exists {
		current = zeroOID
	}
	if cmd.oldOID != current {
		if cmd.oldOID == zeroOID && exists {
			return ng("already exists")
		}
		return ng("old value does not match")
	}
	if cmd.newOID == zeroOID {
		// Delete.
		if !exists {
			return ng("ref does not exist")
		}
		delete(r.Refs, cmd.ref)
		*refsChanged = true
		return ok()
	}
	if cmd.newOID == cmd.oldOID {
		return ok()
	}
	if _, ok := r.Objects[cmd.newOID]; !ok {
		return ng("object not found")
	}
	if cmd.oldOID != zeroOID && !r.isAncestor(cmd.newOID, cmd.oldOID) {
		return ng("non-fast-forward")
	}
	r.Refs[cmd.ref] = cmd.newOID
	*refsChanged = true
	return ok()
}

// pushReport renders the report-status answer: "unpack ok" plus one line per
// command, each line newline-terminated (the client splits the demuxed
// stream on newlines), inside sideband band-1 packets when requested, else
// raw pkt-lines.
func pushReport(unpackOK bool, unpackDetail string, reports []string, sideband bool) []byte {
	var lines []string
	if unpackOK {
		lines = append(lines, "unpack ok\n")
	} else {
		detail := unpackDetail
		if detail == "" {
			detail = "pack error"
		}
		lines = append(lines, "unpack "+detail+"\n")
	}
	for _, report := range reports {
		lines = append(lines, report+"\n")
	}
	var buf bytes.Buffer
	if sideband {
		for _, line := range lines {
			// Each report line is its own band-1 packet.
			framed := make([]byte, 0, len(line)+1)
			framed = append(framed, 1)
			framed = append(framed, line...)
			buf.Write(pktLine(framed))
		}
		buf.Write(pktFlush)
	} else {
		for _, line := range lines {
			buf.Write(pktLine([]byte(line)))
		}
		buf.Write(pktFlush)
	}
	return buf.Bytes()
}
