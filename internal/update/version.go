// Package update implements the agent's fixed-purpose self updater. It only
// talks to the official GitHub repository, verifies a stable release binary
// and replaces the installed agent under a root-held execution lock.
package update

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var releaseTagPattern = regexp.MustCompile(`^agent-v([0-9]+)\.([0-9]+)\.([0-9]+)$`)

// Version is a strict MAJOR.MINOR.PATCH numeric version.
type Version struct {
	Major int
	Minor int
	Patch int
}

// ParseVersion accepts 1.2.3, v1.2.3 and agent-v1.2.3. It rejects prerelease
// suffixes, build metadata and anything that is not exactly three numeric
// components.
func ParseVersion(s string) (Version, error) {
	raw := strings.TrimSpace(s)
	switch {
	case strings.HasPrefix(raw, "agent-v"):
		raw = strings.TrimPrefix(raw, "agent-v")
	case strings.HasPrefix(raw, "v"):
		raw = strings.TrimPrefix(raw, "v")
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return Version{}, fmt.Errorf("update: invalid version %q", s)
	}
	nums := make([]int, 3)
	for i, p := range parts {
		if p == "" || len(p) > 9 || (len(p) > 1 && p[0] == '0') {
			return Version{}, fmt.Errorf("update: invalid version %q", s)
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return Version{}, fmt.Errorf("update: invalid version %q", s)
			}
		}
		n, err := strconv.Atoi(p)
		if err != nil {
			return Version{}, fmt.Errorf("update: invalid version %q", s)
		}
		nums[i] = n
	}
	return Version{Major: nums[0], Minor: nums[1], Patch: nums[2]}, nil
}

// ParseReleaseTag accepts only the stable agent tag form used by this
// repository: agent-vMAJOR.MINOR.PATCH.
func ParseReleaseTag(tag string) (Version, bool) {
	m := releaseTagPattern.FindStringSubmatch(tag)
	if m == nil {
		return Version{}, false
	}
	v, err := ParseVersion(tag)
	if err != nil || v.Tag() != tag {
		return Version{}, false
	}
	return v, true
}

// Compare returns -1, 0 or 1.
func (v Version) Compare(o Version) int {
	if v.Major != o.Major {
		return cmpInt(v.Major, o.Major)
	}
	if v.Minor != o.Minor {
		return cmpInt(v.Minor, o.Minor)
	}
	return cmpInt(v.Patch, o.Patch)
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// String returns the canonical MAJOR.MINOR.PATCH form.
func (v Version) String() string {
	return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
}

// Tag returns the release tag for this version.
func (v Version) Tag() string { return "agent-v" + v.String() }
