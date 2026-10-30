package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// RepoOwner and RepoName are fixed. No configuration, panel response or
	// environment variable can redirect the updater to another repository.
	RepoOwner = "HaozeZane"
	RepoName  = "edge-command-panel"

	DefaultAPIBase      = "https://api.github.com"
	DefaultDownloadBase = "https://github.com/" + RepoOwner + "/" + RepoName + "/releases/download"

	assetAmd64     = "edge-agent-linux-amd64"
	assetArm64     = "edge-agent-linux-arm64"
	assetSums      = "SHA256SUMS"
	assetInstaller = "install.sh"

	metadataLimit = 1 << 20
	checksumLimit = 64 << 10
	binaryLimit   = 64 << 20
	maxPages      = 3
	pageSize      = 100
	maxRedirects  = 5
)

// OfficialHosts are the only hosts the updater may contact. The API host is
// separate from the release asset hosts; both are exact matches.
var OfficialHosts = map[string]bool{
	"api.github.com":                       true,
	"github.com":                           true,
	"release-assets.githubusercontent.com": true,
	"objects.githubusercontent.com":        true,
}

// HTTPConfig is the production HTTP policy. Tests may override the bases and
// allow loopback hosts/ports; the bootstrap subcommand never exposes them.
type HTTPConfig struct {
	APIBase         string
	DownloadBase    string
	AllowedHosts    map[string]bool
	AllowCustomPort bool
	AllowHTTP       bool
	MetadataLimit   int64
	ChecksumLimit   int64
	BinaryLimit     int64
	Timeout         time.Duration
	DownloadTimeout time.Duration
	Transport       http.RoundTripper
	UserAgent       string
}

func (c HTTPConfig) withDefaults() HTTPConfig {
	if c.APIBase == "" {
		c.APIBase = DefaultAPIBase
	}
	if c.DownloadBase == "" {
		c.DownloadBase = DefaultDownloadBase
	}
	if c.AllowedHosts == nil {
		c.AllowedHosts = OfficialHosts
	}
	if c.MetadataLimit <= 0 {
		c.MetadataLimit = metadataLimit
	}
	if c.ChecksumLimit <= 0 {
		c.ChecksumLimit = checksumLimit
	}
	if c.BinaryLimit <= 0 {
		c.BinaryLimit = binaryLimit
	}
	if c.Timeout <= 0 {
		c.Timeout = 30 * time.Second
	}
	if c.DownloadTimeout <= 0 {
		c.DownloadTimeout = 5 * time.Minute
	}
	if c.UserAgent == "" {
		c.UserAgent = "edge-command-agent-updater"
	}
	return c
}

// Release is one candidate release.
type Release struct {
	Version Version
	Tag     string
}

type githubRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// RateLimitError reports GitHub's anonymous rate limit.
type RateLimitError struct {
	Status     int
	RetryAfter time.Duration
	Reset      time.Time
	Message    string
}

func (e *RateLimitError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("github: HTTP %d: %s", e.Status, e.Message)
	}
	return fmt.Sprintf("github: HTTP %d rate limited", e.Status)
}

// Client is a policy-constrained GitHub release client.
type Client struct {
	cfg  HTTPConfig
	http *http.Client
}

// NewClient builds a client with the fixed host/redirect policy.
func NewClient(cfg HTTPConfig) *Client {
	cfg = cfg.withDefaults()
	hc := &http.Client{
		// No overall Timeout: metadata and binary requests have different
		// deadlines, enforced by their request contexts below.
		Transport: cfg.Transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return errors.New("update: too many redirects")
			}
			return validateURL(req.URL, cfg)
		},
	}
	return &Client{cfg: cfg, http: hc}
}

func validateURL(u *url.URL, cfg HTTPConfig) error {
	if u == nil {
		return errors.New("update: empty url")
	}
	if u.User != nil {
		return errors.New("update: url userinfo is not allowed")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && !(cfg.AllowHTTP && scheme == "http") {
		return fmt.Errorf("update: url scheme %q is not allowed", u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || !cfg.AllowedHosts[host] {
		return fmt.Errorf("update: host %q is not allowed", u.Hostname())
	}
	if u.Port() != "" && !cfg.AllowCustomPort {
		return fmt.Errorf("update: custom port %q is not allowed", u.Port())
	}
	if u.Path == "" || !strings.HasPrefix(u.Path, "/") {
		return errors.New("update: url path is invalid")
	}
	return nil
}

// ListReleases reads at most three pages of 100 releases and returns only
// stable, strictly versioned agent releases. Other web releases are ignored.
func (c *Client) ListReleases(ctx context.Context) ([]Release, error) {
	var all []Release
	base := strings.TrimRight(c.cfg.APIBase, "/")
	for page := 1; page <= maxPages; page++ {
		endpoint := fmt.Sprintf("%s/repos/%s/%s/releases?per_page=%d&page=%d",
			base, RepoOwner, RepoName, pageSize, page)
		u, err := url.Parse(endpoint)
		if err != nil {
			return nil, fmt.Errorf("update: api url: %w", err)
		}
		if err := validateURL(u, c.cfg); err != nil {
			return nil, err
		}
		body, err := c.getLimited(ctx, endpoint, c.cfg.MetadataLimit)
		if err != nil {
			return nil, err
		}
		var pageReleases []githubRelease
		if err := json.Unmarshal(body, &pageReleases); err != nil {
			return nil, fmt.Errorf("update: invalid release metadata: %w", err)
		}
		for _, r := range pageReleases {
			if r.Draft || r.Prerelease {
				continue
			}
			v, ok := ParseReleaseTag(r.TagName)
			if !ok {
				continue
			}
			all = append(all, Release{Version: v, Tag: r.TagName})
		}
		if len(pageReleases) < pageSize {
			break
		}
	}
	return all, nil
}

// SelectRelease returns the highest stable version greater than current.
func SelectRelease(releases []Release, current Version) (Release, bool) {
	var best Release
	found := false
	for _, r := range releases {
		if r.Version.Compare(current) <= 0 {
			continue
		}
		if !found || r.Version.Compare(best.Version) > 0 {
			best = r
			found = true
		}
	}
	return best, found
}

func (c *Client) getLimited(ctx context.Context, endpoint string, limit int64) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, c.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("update: request: %w", err)
	}
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("update: request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, responseError(resp)
	}
	body, err := readLimited(resp.Body, limit)
	if err != nil {
		return nil, err
	}
	return body, nil
}

// DownloadAsset downloads one fixed release asset to dest, hashing it while
// writing. The caller owns dest and must remove it on failure.
func (c *Client) DownloadAsset(ctx context.Context, tag, asset, dest string) (string, int64, error) {
	if !strings.HasPrefix(tag, "agent-v") {
		return "", 0, fmt.Errorf("update: invalid tag %q", tag)
	}
	switch asset {
	case assetAmd64, assetArm64, assetSums, assetInstaller:
	default:
		return "", 0, fmt.Errorf("update: invalid asset %q", asset)
	}
	base := strings.TrimRight(c.cfg.DownloadBase, "/")
	endpoint := base + "/" + url.PathEscape(tag) + "/" + url.PathEscape(asset)
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", 0, fmt.Errorf("update: asset url: %w", err)
	}
	if err := validateURL(u, c.cfg); err != nil {
		return "", 0, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, c.cfg.DownloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", 0, fmt.Errorf("update: request: %w", err)
	}
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("update: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", 0, responseError(resp)
	}
	limit := c.cfg.BinaryLimit
	if asset == assetSums {
		limit = c.cfg.ChecksumLimit
	} else if asset == assetInstaller {
		limit = c.cfg.ChecksumLimit
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o700)
	if err != nil {
		return "", 0, fmt.Errorf("update: create %s: %w", dest, err)
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, limit+1))
	if copyErr == nil && written > limit {
		copyErr = fmt.Errorf("update: asset %s exceeds %d bytes", asset, limit)
	}
	if copyErr == nil {
		copyErr = f.Sync()
	}
	closeErr := f.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		_ = os.Remove(dest)
		return "", 0, copyErr
	}
	return hex.EncodeToString(h.Sum(nil)), written, nil
}

func responseError(resp *http.Response) error {
	body, _ := readLimited(resp.Body, 8<<10)
	msg := strings.TrimSpace(string(body))
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		rl := &RateLimitError{Status: resp.StatusCode, Message: msg}
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if secs, err := strconv.Atoi(strings.TrimSpace(ra)); err == nil && secs >= 0 {
				rl.RetryAfter = time.Duration(secs) * time.Second
			} else if t, err := http.ParseTime(ra); err == nil {
				rl.RetryAfter = time.Until(t)
			}
		}
		if reset := resp.Header.Get("X-RateLimit-Reset"); reset != "" {
			if secs, err := strconv.ParseInt(strings.TrimSpace(reset), 10, 64); err == nil {
				rl.Reset = time.Unix(secs, 0)
			}
		}
		return rl
	}
	return fmt.Errorf("update: HTTP %d: %s", resp.StatusCode, msg)
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, fmt.Errorf("update: read response: %w", err)
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("update: response exceeds %d bytes", limit)
	}
	return b, nil
}
