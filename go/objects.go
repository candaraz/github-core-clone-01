// Git objects: hashing, tree/commit/tag codecs, packfiles, reachability,
// ancestry, merge-base and tree diffs. All functions here are pure over the
// bytes plus a Repo's object map; callers hold Store.mu.

package main

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

const zeroOID = "0000000000000000000000000000000000000000"

// --- object ids ---

func isOID(s string) bool {
	if len(s) != 40 {
		return false
	}
	for i := 0; i < 40; i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// hashObject is git's object id: SHA-1 over "<type> <size>\0" + bytes.
func hashObject(typ string, data []byte) string {
	h := sha1.New()
	h.Write([]byte(typ))
	h.Write([]byte(" "))
	h.Write([]byte(strconv.Itoa(len(data))))
	h.Write([]byte{0})
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

func oidBytes(oid string) ([]byte, bool) {
	if !isOID(oid) {
		return nil, false
	}
	b, err := hex.DecodeString(oid)
	if err != nil || len(b) != 20 {
		return nil, false
	}
	return b, true
}

// --- storing objects ---

// putObject stores an object, computing its id, and caches its parsed form.
// Returns the id. Malformed commits/trees are stored raw with no cache entry;
// walks treat them as leaves rather than failing.
func (r *Repo) putObject(typ string, data []byte) string {
	oid := hashObject(typ, data)
	if _, exists := r.Objects[oid]; exists {
		return oid
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	r.Objects[oid] = &Object{Type: typ, Data: cp}
	switch typ {
	case "commit":
		if ci, ok := parseCommit(cp); ok {
			r.CommitCache[oid] = ci
		}
	case "tree":
		if entries, ok := parseTree(cp); ok {
			r.TreeCache[oid] = entries
		}
	}
	return oid
}

// commitInfo returns the parsed commit, parsing on demand when the cache
// missed (objects stored before caching existed, or malformed bytes).
func (r *Repo) commitInfo(oid string) *CommitInfo {
	if ci, ok := r.CommitCache[oid]; ok {
		return ci
	}
	obj := r.Objects[oid]
	if obj == nil || obj.Type != "commit" {
		return nil
	}
	ci, ok := parseCommit(obj.Data)
	if !ok {
		return nil
	}
	r.CommitCache[oid] = ci
	return ci
}

func (r *Repo) treeEntries(oid string) []TreeEntry {
	if entries, ok := r.TreeCache[oid]; ok {
		return entries
	}
	obj := r.Objects[oid]
	if obj == nil || obj.Type != "tree" {
		return nil
	}
	entries, ok := parseTree(obj.Data)
	if !ok {
		return nil
	}
	r.TreeCache[oid] = entries
	return entries
}

// --- tree codec ---

// parseTree parses "<mode> <name>\0<20-byte oid>" entries in stored order.
func parseTree(data []byte) ([]TreeEntry, bool) {
	var entries []TreeEntry
	off := 0
	for off < len(data) {
		sp := bytes.IndexByte(data[off:], ' ')
		if sp < 0 {
			return nil, false
		}
		mode := string(data[off : off+sp])
		rest := off + sp + 1
		nul := bytes.IndexByte(data[rest:], 0)
		if nul < 0 || rest+nul+21 > len(data) {
			return nil, false
		}
		name := string(data[rest : rest+nul])
		oid := hex.EncodeToString(data[rest+nul+1 : rest+nul+21])
		// Modes are octal; reject anything else.
		for i := 0; i < len(mode); i++ {
			if mode[i] < '0' || mode[i] > '7' {
				return nil, false
			}
		}
		entries = append(entries, TreeEntry{Mode: mode, Name: name, OID: oid})
		off = rest + nul + 21
	}
	return entries, true
}

// treeSortKey is git's tree-entry sort: byte order of the name, a directory
// compared as if it ended in '/'.
func treeSortKey(e TreeEntry) string {
	if e.Mode == "40000" {
		return e.Name + "/"
	}
	return e.Name
}

func sortTreeEntries(entries []TreeEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		return treeSortKey(entries[i]) < treeSortKey(entries[j])
	})
}

// buildTreeBytes encodes entries, sorted the way git sorts them.
func buildTreeBytes(entries []TreeEntry) ([]byte, bool) {
	sorted := make([]TreeEntry, len(entries))
	copy(sorted, entries)
	sortTreeEntries(sorted)
	var buf bytes.Buffer
	for _, e := range sorted {
		raw, ok := oidBytes(e.OID)
		if !ok {
			return nil, false
		}
		buf.WriteString(e.Mode)
		buf.WriteByte(' ')
		buf.WriteString(e.Name)
		buf.WriteByte(0)
		buf.Write(raw)
	}
	return buf.Bytes(), true
}

// --- commit/tag codec ---

// parseCommit extracts tree, parents, author, committer and message. The
// message is the verbatim bytes after the blank line.
func parseCommit(data []byte) (*CommitInfo, bool) {
	blank := bytes.Index(data, []byte("\n\n"))
	headerEnd := len(data)
	message := ""
	if blank >= 0 {
		headerEnd = blank
		message = string(data[blank+2:])
	}
	ci := &CommitInfo{Message: message}
	for _, line := range strings.Split(string(data[:headerEnd]), "\n") {
		if line == "" {
			continue
		}
		sp := strings.IndexByte(line, ' ')
		key, val := line, ""
		if sp >= 0 {
			key, val = line[:sp], line[sp+1:]
		}
		switch key {
		case "tree":
			ci.Tree = val
		case "parent":
			ci.Parents = append(ci.Parents, val)
		case "author":
			ci.Author = val
		case "committer":
			ci.Committer = val
		}
	}
	if !isOID(ci.Tree) {
		return nil, false
	}
	for _, p := range ci.Parents {
		if !isOID(p) {
			return nil, false
		}
	}
	return ci, true
}

// parseTagObject returns the tag's target oid and target type.
func parseTagObject(data []byte) (object, typ string, ok bool) {
	blank := bytes.Index(data, []byte("\n\n"))
	headerEnd := len(data)
	if blank >= 0 {
		headerEnd = blank
	}
	for _, line := range strings.Split(string(data[:headerEnd]), "\n") {
		if line == "" {
			continue
		}
		sp := strings.IndexByte(line, ' ')
		if sp < 0 {
			return "", "", false
		}
		switch line[:sp] {
		case "object":
			object = line[sp+1:]
		case "type":
			typ = line[sp+1:]
		}
	}
	if !isOID(object) {
		return "", "", false
	}
	switch typ {
	case "commit", "tree", "blob", "tag":
	default:
		return "", "", false
	}
	return object, typ, true
}

// buildCommitBytes renders a commit object. The message is stored verbatim.
func buildCommitBytes(tree string, parents []string, author, committer string, timestamp int64, message string) []byte {
	var buf bytes.Buffer
	buf.WriteString("tree " + tree + "\n")
	for _, p := range parents {
		buf.WriteString("parent " + p + "\n")
	}
	ts := strconv.FormatInt(timestamp, 10)
	buf.WriteString("author " + author + " " + ts + " +0000\n")
	buf.WriteString("committer " + committer + " " + ts + " +0000\n")
	buf.WriteString("\n")
	buf.WriteString(message)
	return buf.Bytes()
}

// peelToCommit follows annotated tags to the commit they point at. Returns
// the input oid unchanged when it is not a tag object.
func (r *Repo) peelToCommit(oid string) string {
	seen := map[string]bool{}
	for {
		if seen[oid] {
			return oid
		}
		seen[oid] = true
		obj := r.Objects[oid]
		if obj == nil || obj.Type != "tag" {
			return oid
		}
		target, _, ok := parseTagObject(obj.Data)
		if !ok {
			return oid
		}
		oid = target
	}
}

// peelTag returns the commit a tag ref peels to, and whether the ref points
// at a tag object at all.
func (r *Repo) peelTag(oid string) (string, bool) {
	obj := r.Objects[oid]
	if obj == nil || obj.Type != "tag" {
		return "", false
	}
	return r.peelToCommit(oid), true
}

// --- reachability and ancestry ---

// collectReachable returns every object reachable from roots: commit -> tree
// + parents, tag -> target, tree -> entries (gitlinks skipped), blob -> none.
// Missing objects are skipped (allowMissing semantics): a fetch for a
// partially-held graph must not fail the whole response.
func (r *Repo) collectReachable(roots []string) map[string]bool {
	seen := make(map[string]bool)
	stack := append([]string(nil), roots...)
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[oid] || !isOID(oid) {
			continue
		}
		obj := r.Objects[oid]
		if obj == nil {
			continue
		}
		seen[oid] = true
		switch obj.Type {
		case "commit":
			if ci := r.commitInfo(oid); ci != nil {
				stack = append(stack, ci.Tree)
				stack = append(stack, ci.Parents...)
			}
		case "tag":
			if target, _, ok := parseTagObject(obj.Data); ok {
				stack = append(stack, target)
			}
		case "tree":
			for _, e := range r.treeEntries(oid) {
				if e.Mode == "160000" {
					continue
				}
				stack = append(stack, e.OID)
			}
		}
	}
	return seen
}

// isAncestor reports whether old is reachable from new by following parents
// (tags peeled first). new == old counts as an ancestor.
func (r *Repo) isAncestor(newOID, oldOID string) bool {
	newC := r.peelToCommit(newOID)
	oldC := r.peelToCommit(oldOID)
	if newC == oldC {
		return true
	}
	seen := map[string]bool{newC: true}
	stack := []string{newC}
	for len(stack) > 0 {
		oid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		ci := r.commitInfo(oid)
		if ci == nil {
			continue
		}
		for _, p := range ci.Parents {
			if p == oldC {
				return true
			}
			if !seen[p] {
				seen[p] = true
				stack = append(stack, p)
			}
		}
	}
	return false
}

// mergeBase finds a nearest common ancestor of a and b (both peeled to
// commits), or "" when the histories are unrelated.
func (r *Repo) mergeBase(a, b string) string {
	a = r.peelToCommit(a)
	b = r.peelToCommit(b)
	if a == b {
		return a
	}
	// Distances from a.
	dist := map[string]int{a: 0}
	queue := []string{a}
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		ci := r.commitInfo(oid)
		if ci == nil {
			continue
		}
		for _, p := range ci.Parents {
			if _, ok := dist[p]; !ok {
				dist[p] = dist[oid] + 1
				queue = append(queue, p)
			}
		}
	}
	// BFS from b; the first commit also reachable from a with the smallest
	// combined distance wins. A plain BFS from b returns the nearest to b,
	// which is a valid merge base for these histories.
	seen := map[string]bool{b: true}
	queue = []string{b}
	best := ""
	bestDist := -1
	for len(queue) > 0 {
		oid := queue[0]
		queue = queue[1:]
		if d, ok := dist[oid]; ok {
			if bestDist < 0 || d < bestDist {
				best, bestDist = oid, d
			}
		}
		ci := r.commitInfo(oid)
		if ci == nil {
			continue
		}
		for _, p := range ci.Parents {
			if !seen[p] {
				seen[p] = true
				queue = append(queue, p)
			}
		}
	}
	return best
}

// history returns commits reachable from tip, newest first (depth-first
// pre-order, parents after the commit), deduplicated.
func (r *Repo) history(tip string) []string {
	var out []string
	seen := map[string]bool{}
	var walk func(oid string)
	walk = func(oid string) {
		if seen[oid] {
			return
		}
		seen[oid] = true
		ci := r.commitInfo(oid)
		if ci == nil {
			return
		}
		out = append(out, oid)
		for _, p := range ci.Parents {
			walk(p)
		}
	}
	walk(r.peelToCommit(tip))
	return out
}

// --- flat tree views and diffs ---

// flatEntry is one path in a flattened tree.
type flatEntry struct {
	Mode string
	OID  string
}

// flattenTree returns path -> entry for every blob (and gitlink) in a tree,
// recursing into subtrees.
func (r *Repo) flattenTree(treeOID string) map[string]flatEntry {
	out := map[string]flatEntry{}
	var walk func(treeOID, prefix string)
	walk = func(treeOID, prefix string) {
		for _, e := range r.treeEntries(treeOID) {
			path := prefix + e.Name
			if e.Mode == "40000" {
				walk(e.OID, path+"/")
			} else {
				out[path] = flatEntry{Mode: e.Mode, OID: e.OID}
			}
		}
	}
	if treeOID != "" {
		walk(treeOID, "")
	}
	return out
}

// treeOfCommit returns the tree oid of a commit (tags peeled), or "".
func (r *Repo) treeOfCommit(oid string) string {
	ci := r.commitInfo(r.peelToCommit(oid))
	if ci == nil {
		return ""
	}
	return ci.Tree
}

// resolveRef turns a ref name, branch/tag short name, or oid into a commit
// oid. The second result is false when nothing resolves.
func (r *Repo) resolveRef(ref string) (string, bool) {
	if oid, ok := r.Refs[ref]; ok {
		return oid, true
	}
	if oid, ok := r.Refs["refs/heads/"+ref]; ok {
		return oid, true
	}
	if oid, ok := r.Refs["refs/tags/"+ref]; ok {
		return oid, true
	}
	if isOID(ref) {
		if _, ok := r.Objects[ref]; ok {
			return ref, true
		}
	}
	return "", false
}

// lookupPath walks a tree to a path. Returns the entry and whether it names a
// directory (mode 40000), or false when the path is absent.
func (r *Repo) lookupPath(treeOID, path string) (TreeEntry, bool, bool) {
	segments := strings.Split(path, "/")
	cur := treeOID
	for i, seg := range segments {
		if seg == "" {
			return TreeEntry{}, false, false
		}
		found := false
		for _, e := range r.treeEntries(cur) {
			if e.Name == seg {
				if i == len(segments)-1 {
					return e, e.Mode == "40000", true
				}
				if e.Mode != "40000" {
					return TreeEntry{}, false, false
				}
				cur = e.OID
				found = true
				break
			}
		}
		if !found {
			return TreeEntry{}, false, false
		}
	}
	return TreeEntry{}, false, false
}

// --- building trees from flat maps ---

type dirNode struct {
	dirs  map[string]*dirNode
	files map[string]flatEntry
}

func newDirNode() *dirNode {
	return &dirNode{dirs: map[string]*dirNode{}, files: map[string]flatEntry{}}
}

// buildTreeFromFlat stores the tree objects for a flat path map and returns
// the root tree oid.
func (r *Repo) buildTreeFromFlat(flat map[string]flatEntry) string {
	root := newDirNode()
	for path, ent := range flat {
		segments := strings.Split(path, "/")
		node := root
		for _, seg := range segments[:len(segments)-1] {
			child, ok := node.dirs[seg]
			if !ok {
				child = newDirNode()
				node.dirs[seg] = child
			}
			node = child
		}
		node.files[segments[len(segments)-1]] = ent
	}
	var build func(n *dirNode) string
	build = func(n *dirNode) string {
		var entries []TreeEntry
		for name, ent := range n.files {
			entries = append(entries, TreeEntry{Mode: ent.Mode, Name: name, OID: ent.OID})
		}
		for name, child := range n.dirs {
			entries = append(entries, TreeEntry{Mode: "40000", Name: name, OID: build(child)})
		}
		data, ok := buildTreeBytes(entries)
		if !ok {
			return ""
		}
		return r.putObject("tree", data)
	}
	return build(root)
}

// --- packfiles ---

var errPack = errors.New("pack error")

const (
	packCommit   = 1
	packTree     = 2
	packBlob     = 3
	packTag      = 4
	packOfsDelta = 6
	packRefDelta = 7
)

func typeCode(typ string) int {
	switch typ {
	case "commit":
		return packCommit
	case "tree":
		return packTree
	case "blob":
		return packBlob
	case "tag":
		return packTag
	}
	return 0
}

func codeType(code int) string {
	switch code {
	case packCommit:
		return "commit"
	case packTree:
		return "tree"
	case packBlob:
		return "blob"
	case packTag:
		return "tag"
	}
	return ""
}

// readPack parses a packfile and returns its objects in pack order, resolving
// OFS_DELTA and REF_DELTA entries. REF_DELTA bases may come from the repo's
// store (thin packs) via the lookup fallback.
func (r *Repo) readPack(pack []byte) ([]*Object, error) {
	if len(pack) < 32 {
		return nil, fmt.Errorf("%w: pack is %d bytes, too short", errPack, len(pack))
	}
	if string(pack[0:4]) != "PACK" {
		return nil, fmt.Errorf("%w: pack does not start with PACK", errPack)
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("%w: unsupported pack version %d", errPack, version)
	}
	count := binary.BigEndian.Uint32(pack[8:12])
	trailerStart := len(pack) - 20
	trailer := pack[trailerStart:]
	sum := sha1.Sum(pack[:trailerStart])
	if !bytes.Equal(trailer, sum[:]) {
		return nil, fmt.Errorf("%w: pack trailer checksum mismatch", errPack)
	}

	type rawEntry struct {
		offset   int
		typeCode int
		size     int
		data     []byte // inflated delta data or object data
		baseOff  int    // OFS_DELTA: absolute offset of the base entry
		baseOID  string // REF_DELTA: base object id
		typ      string // resolved type
		resolved []byte
	}
	raw := make([]*rawEntry, 0, count)
	byOffset := make(map[int]*rawEntry)
	off := 12
	for i := uint32(0); i < count; i++ {
		entryOffset := off
		if off >= trailerStart {
			return nil, fmt.Errorf("%w: pack entry %d starts past the trailer", errPack, i)
		}
		// Size varint: first byte holds type in bits 4-6 and low 4 size bits.
		b := pack[off]
		off++
		typeCode := int(b>>4) & 0x07
		size := int(b & 0x0f)
		shift := uint(4)
		for b&0x80 != 0 {
			if off >= trailerStart {
				return nil, fmt.Errorf("%w: pack entry size varint truncated", errPack)
			}
			b = pack[off]
			off++
			size += int(b&0x7f) << shift
			shift += 7
			if shift > 63 {
				return nil, fmt.Errorf("%w: pack entry size varint too long", errPack)
			}
		}
		e := &rawEntry{offset: entryOffset, typeCode: typeCode, size: size}
		if typeCode == packOfsDelta {
			// OFS_DELTA base offset: big-endian-ish variable encoding.
			if off >= trailerStart {
				return nil, fmt.Errorf("%w: ofs-delta has no base offset", errPack)
			}
			b = pack[off]
			off++
			value := int(b & 0x7f)
			for b&0x80 != 0 {
				if off >= trailerStart {
					return nil, fmt.Errorf("%w: ofs-delta base offset truncated", errPack)
				}
				b = pack[off]
				off++
				value = ((value + 1) << 7) + int(b&0x7f)
			}
			if value <= 0 || value > entryOffset {
				return nil, fmt.Errorf("%w: ofs-delta names invalid base offset %d", errPack, value)
			}
			e.baseOff = entryOffset - value
		} else if typeCode == packRefDelta {
			if off+20 > trailerStart {
				return nil, fmt.Errorf("%w: ref-delta base id truncated", errPack)
			}
			e.baseOID = hex.EncodeToString(pack[off : off+20])
			off += 20
		} else if codeType(typeCode) == "" {
			return nil, fmt.Errorf("%w: pack entry %d has unknown type code %d", errPack, i, typeCode)
		}
		data, next, err := inflateAt(pack, off, trailerStart)
		if err != nil {
			return nil, err
		}
		if len(data) != size {
			return nil, fmt.Errorf("%w: pack entry %d inflated to %d bytes, declared %d", errPack, i, len(data), size)
		}
		off = next
		e.data = data
		raw = append(raw, e)
		byOffset[entryOffset] = e
	}
	if off != trailerStart {
		return nil, fmt.Errorf("%w: %d trailing bytes before the trailer", errPack, trailerStart-off)
	}

	// Resolve deltas (bases always precede their deltas for OFS; REF bases
	// may live in the store).
	var resolve func(e *rawEntry, depth int) error
	resolve = func(e *rawEntry, depth int) error {
		if depth > 1024 {
			return fmt.Errorf("%w: delta chain too deep", errPack)
		}
		if e.resolved != nil {
			return nil
		}
		switch e.typeCode {
		case packOfsDelta, packRefDelta:
			var base *rawEntry
			var baseType string
			var baseData []byte
			if e.typeCode == packOfsDelta {
				base = byOffset[e.baseOff]
				if base == nil {
					return fmt.Errorf("%w: ofs-delta base offset %d not found", errPack, e.baseOff)
				}
				if err := resolve(base, depth+1); err != nil {
					return err
				}
				baseType, baseData = base.typ, base.resolved
			} else {
				if obj := r.Objects[e.baseOID]; obj != nil {
					baseType, baseData = obj.Type, obj.Data
				} else {
					// A REF base inside the same pack: resolve every plain
					// entry, then match by object id.
					found := false
					for _, cand := range raw {
						if cand.typeCode == packOfsDelta || cand.typeCode == packRefDelta {
							continue
						}
						if err := resolve(cand, depth+1); err != nil {
							return err
						}
						if hashObject(cand.typ, cand.resolved) == e.baseOID {
							baseType, baseData, found = cand.typ, cand.resolved, true
							break
						}
					}
					if !found {
						return fmt.Errorf("%w: ref-delta base %s not found", errPack, e.baseOID)
					}
				}
			}
			out, err := applyDelta(baseData, e.data)
			if err != nil {
				return err
			}
			e.typ, e.resolved = baseType, out
		default:
			e.typ = codeType(e.typeCode)
			e.resolved = e.data
		}
		return nil
	}
	out := make([]*Object, 0, len(raw))
	for _, e := range raw {
		if err := resolve(e, 0); err != nil {
			return nil, err
		}
		out = append(out, &Object{Type: e.typ, Data: e.resolved})
	}
	return out, nil
}

// inflateAt inflates one zlib stream starting at off (bounded by limit) and
// returns its bytes plus the offset just past the stream. The consumed length
// is exact: bytes pulled from the slice minus bytes still sitting in the
// bufio buffer. flate never reads past the stream end (it stops at the final
// block and the zlib wrapper reads exactly four checksum bytes), so the
// accounting holds for every stream.
func inflateAt(pack []byte, off, limit int) ([]byte, int, error) {
	if off >= limit {
		return nil, 0, fmt.Errorf("%w: zlib stream starts past the pack end", errPack)
	}
	sr := bytes.NewReader(pack[off:limit])
	initial := sr.Len()
	br := bufio.NewReader(sr)
	zr, err := zlib.NewReader(br)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: zlib stream at offset %d did not inflate: %v", errPack, off, err)
	}
	data, err := io.ReadAll(zr)
	zr.Close()
	if err != nil {
		return nil, 0, fmt.Errorf("%w: zlib stream at offset %d did not inflate: %v", errPack, off, err)
	}
	consumed := initial - sr.Len() - br.Buffered()
	if consumed <= 0 {
		return nil, 0, fmt.Errorf("%w: zlib stream at offset %d consumed no bytes", errPack, off)
	}
	return data, off + consumed, nil
}

// applyDelta applies a git delta instruction stream to a base object's bytes.
func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readSize := func() (int, error) {
		value := 0
		shift := uint(0)
		for {
			if off >= len(delta) {
				return 0, fmt.Errorf("%w: delta size varint truncated", errPack)
			}
			b := delta[off]
			off++
			value += int(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
			if shift > 63 {
				return 0, fmt.Errorf("%w: delta size varint too long", errPack)
			}
		}
		return value, nil
	}
	sourceSize, err := readSize()
	if err != nil {
		return nil, err
	}
	targetSize, err := readSize()
	if err != nil {
		return nil, err
	}
	if sourceSize != len(base) {
		return nil, fmt.Errorf("%w: delta expects a %d-byte base, got %d", errPack, sourceSize, len(base))
	}
	out := make([]byte, 0, targetSize)
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			copyOff, copySize := 0, 0
			shift := uint(0)
			for bit := 0; bit < 4; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if off >= len(delta) {
						return nil, fmt.Errorf("%w: delta copy offset truncated", errPack)
					}
					copyOff += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			shift = 0
			for bit := 4; bit < 7; bit++ {
				if op&(1<<uint(bit)) != 0 {
					if off >= len(delta) {
						return nil, fmt.Errorf("%w: delta copy size truncated", errPack)
					}
					copySize += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			if copySize == 0 {
				copySize = 0x10000
			}
			if copyOff+copySize > len(base) {
				return nil, fmt.Errorf("%w: delta copy is out of the base", errPack)
			}
			if len(out)+copySize > targetSize {
				return nil, fmt.Errorf("%w: delta writes past its target size", errPack)
			}
			out = append(out, base[copyOff:copyOff+copySize]...)
		} else if op != 0 {
			literal := int(op & 0x7f)
			if off+literal > len(delta) {
				return nil, fmt.Errorf("%w: delta insert truncated", errPack)
			}
			if len(out)+literal > targetSize {
				return nil, fmt.Errorf("%w: delta writes past its target size", errPack)
			}
			out = append(out, delta[off:off+literal]...)
			off += literal
		} else {
			return nil, fmt.Errorf("%w: delta opcode 0 is invalid", errPack)
		}
	}
	if len(out) != targetSize {
		return nil, fmt.Errorf("%w: delta produced %d of %d bytes", errPack, len(out), targetSize)
	}
	return out, nil
}

// writePack builds a packfile from plain objects (no deltas), in the given
// order, with a SHA-1 trailer. Deflate level 1: pack bytes stay valid at any
// level, and level 1 is the fastest.
func writePack(objects []*Object) []byte {
	var buf bytes.Buffer
	header := make([]byte, 12)
	copy(header[0:4], "PACK")
	binary.BigEndian.PutUint32(header[4:8], 2)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(objects)))
	buf.Write(header)
	for _, obj := range objects {
		writePackObjectHeader(&buf, typeCode(obj.Type), len(obj.Data))
		zw, _ := zlib.NewWriterLevel(&buf, 1)
		zw.Write(obj.Data)
		zw.Close()
	}
	body := buf.Bytes()
	sum := sha1.Sum(body)
	buf.Write(sum[:])
	return buf.Bytes()
}

func writePackObjectHeader(buf *bytes.Buffer, code, size int) {
	remaining := size
	first := (code << 4) | (remaining & 0x0f)
	remaining /= 16
	for remaining > 0 {
		buf.WriteByte(byte(first | 0x80))
		first = remaining & 0x7f
		remaining /= 128
	}
	buf.WriteByte(byte(first))
}

// --- server-created commits ---

// newServerCommit stores a commit with the fixed identity and the repo's next
// monotonic timestamp, and returns its oid.
func (r *Repo) newServerCommit(tree string, parents []string, message string) string {
	r.CommitSeq++
	ts := commitEpochSec + int64(r.CommitSeq)
	data := buildCommitBytes(tree, parents, commitIdent, commitIdent, ts, message)
	return r.putObject("commit", data)
}
