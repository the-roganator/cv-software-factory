/**
 * Logos for the packages and providers the console names, and the places the footer links to, from theSVG (MIT; the
 * marks belong to their owners). Bundled with the console and never fetched, and defined once, as symbols that each
 * use refers to. GitHub's and LinkedIn's, and the tools' (OpenTelemetry, Trivy, Anthropic), are drawn in the text
 * colour, so they follow the theme; a package's own logo keeps its colours. The tools in Martin's menu have theirs in
 * `ToolLogos.tsx`, which only he loads.
 *
 * The tool marks beside the evidence (`ToolMark`) are images rather than code: one-colour drawings in `../marks/`, used
 * as a CSS mask over the text colour, so the browser fetches each only when the page shows something its tool made.
 * Kubernetes', Argo's (Argo CD's and Argo Rollouts' alike), Prometheus' and Playwright's are theSVG's one-colour
 * versions, the last Simple Icons' (CC0); Loki's, Kyverno's (its symbol, without the name) and Sigstore's are theSVG's
 * drawings in one colour. Tempo's is selfh.st's (`selfhst:grafana-tempo` on Iconify, CC BY 4.0), in one colour.
 */

type Logo = 'node' | 'otel' | 'trivy' | 'dependabot' | 'anthropic' | 'jev' | 'github' | 'linkedin';

/** Draws a logo defined by LogoSymbols. */
export function LogoMark({ name, className }: { name: Logo; className?: string }) {
  return (
    <svg className={className ?? 'logo'} viewBox={VIEWBOX[name]} aria-hidden="true">
      <use href={`#logo-${name}`} />
    </svg>
  );
}

const VIEWBOX: Record<Logo, string> = {
  node: '0 0 256 292',
  otel: '0 0 24 24',
  trivy: '0 0 24 24',
  dependabot: '0 0 24 24',
  anthropic: '0 0 24 24',
  jev: '0 0 16 16',
  github: '0 0 16 16',
  linkedin: '0 0 64 64',
};

/** The tools whose marks stand beside what they made, in `base.css` as `.toolmark-<name>`. */
export type ToolName = 'kubernetes' | 'argo' | 'prometheus' | 'loki' | 'tempo' | 'playwright' | 'kyverno' | 'sigstore';

/**
 * A tool's mark, at text height in `text-muted`, hidden from a screen reader: the words beside it name the tool. It
 * appears only beside something its tool produced or did, never as decoration.
 */
export function ToolMark({ name }: { name: ToolName }) {
  return <span className={`toolmark toolmark-${name}`} aria-hidden="true" />;
}

/** The logo for a package, when the console has one. */
export function logoFor(name: string): Logo | undefined {
  if (/^node(\.js)?\b/i.test(name)) return 'node';
  if (name.startsWith('@opentelemetry/')) return 'otel';
  return undefined;
}

/** Every logo's drawing, once, for the page. */
export function LogoSymbols() {
  return (
    <svg className="sprite" width="0" height="0" aria-hidden="true">
      <symbol id="logo-node" viewBox="0 0 256 292">
        <defs>
          <linearGradient id="node-a" x1="68.188%" x2="27.823%" y1="17.487%" y2="89.755%">
            <stop offset="0%" stopColor="#41873f" />
            <stop offset="32.88%" stopColor="#418b3d" />
            <stop offset="63.52%" stopColor="#419637" />
            <stop offset="93.19%" stopColor="#3fa92d" />
            <stop offset="100%" stopColor="#3fae2a" />
          </linearGradient>
          <linearGradient id="node-b" x1="43.277%" x2="159.245%" y1="55.169%" y2="-18.306%">
            <stop offset="13.76%" stopColor="#41873f" />
            <stop offset="40.32%" stopColor="#54a044" />
            <stop offset="71.36%" stopColor="#66b848" />
            <stop offset="90.81%" stopColor="#6cc04a" />
          </linearGradient>
          <linearGradient id="node-c" x1="-4.389%" x2="101.499%" y1="49.997%" y2="49.997%">
            <stop offset="9.192%" stopColor="#6cc04a" />
            <stop offset="28.64%" stopColor="#66b848" />
            <stop offset="59.68%" stopColor="#54a044" />
            <stop offset="86.24%" stopColor="#41873f" />
          </linearGradient>
          <path
            id="node-d"
            d="M134.923 1.832c-4.344-2.443-9.502-2.443-13.846 0L6.787 67.801C2.443 70.244 0 74.859 0 79.745v132.208c0 4.887 2.715 9.502 6.787 11.945l114.29 65.968c4.344 2.444 9.502 2.444 13.846 0l114.29-65.968c4.344-2.443 6.787-7.058 6.787-11.945V79.745c0-4.886-2.715-9.501-6.787-11.944z"
          />
          <mask id="node-m" fill="#fff">
            <use href="#node-d" />
          </mask>
        </defs>
        <path
          fill="url(#node-a)"
          d="M134.923 1.832c-4.344-2.443-9.502-2.443-13.846 0L6.787 67.801C2.443 70.244 0 74.859 0 79.745v132.208c0 4.887 2.715 9.502 6.787 11.945l114.29 65.968c4.344 2.444 9.502 2.444 13.846 0l114.29-65.968c4.344-2.443 6.787-7.058 6.787-11.945V79.745c0-4.886-2.715-9.501-6.787-11.944z"
        />
        <path
          fill="url(#node-b)"
          d="M249.485 67.8L134.65 1.833c-1.086-.542-2.443-1.085-3.529-1.357L2.443 220.912c1.086 1.357 2.444 2.443 3.8 3.258l114.834 65.968c3.258 1.9 7.059 2.443 10.588 1.357L252.47 70.515c-.815-1.086-1.9-1.9-2.986-2.714Z"
          mask="url(#node-m)"
        />
        <path
          fill="url(#node-c)"
          d="M249.756 223.898c3.258-1.9 5.701-5.158 6.787-8.687L130.579.204c-3.258-.543-6.787-.272-9.773 1.628L6.786 67.53l122.979 224.238c1.628-.272 3.529-.815 5.158-1.63l114.833-66.239Z"
          mask="url(#node-m)"
        />
      </symbol>
      <symbol id="logo-otel" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          d="M12.697 13.117A2.618 2.618 0 1 0 16.4 16.82a2.618 2.618 0 0 0-3.703-3.703m2.768 2.77a1.296 1.296 0 1 1-1.833-1.832a1.296 1.296 0 0 1 1.833 1.832M16.356.236L14.752 1.84a.81.81 0 0 0 0 1.144l6.263 6.263a.81.81 0 0 0 1.144 0l1.604-1.604a.81.81 0 0 0 0-1.144L17.498.235a.81.81 0 0 0-1.142 0M5.117 20.734a.733.733 0 0 0 0-1.034l-.815-.816a.733.733 0 0 0-1.035 0l-1.684 1.685l-.003.002l-.462-.463a.654.654 0 1 0-.925.925l2.775 2.775a.654.654 0 1 0 .925-.925l-.463-.462l.003-.002zm8.486-15.893l-3.564 3.564a.82.82 0 0 0 0 1.154l2.2 2.2a3.98 3.98 0 0 1 5.137.419l1.782-1.782a.82.82 0 0 0 0-1.154l-4.401-4.4a.815.815 0 0 0-1.154 0m-2.288 7.846l-1.3-1.3a.786.786 0 0 0-1.108 0l-4.583 4.586a.786.786 0 0 0 0 1.107l2.597 2.598a.786.786 0 0 0 1.108 0l2.947-2.953a3.99 3.99 0 0 1 .339-4.038"
        />
      </symbol>
      <symbol id="logo-trivy" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          d="M4.375 7.311L1.962 5.918a.1.1 0 0 1 0-.174L11.828.047a.34.34 0 0 1 .344 0l9.864 5.696a.1.1 0 0 1 0 .175L19.624 7.31a1 1 0 0 1-.052-.074c-.914-1.478-2.124-2.592-3.596-3.31c-4.088-1.994-9.164-.505-11.6 3.385Zm7.887 16.588v-3.14c5.693-2.087 9.01-7.766 7.588-12.985l2.436-1.42a.1.1 0 0 1 .151.088v11.645a.1.1 0 0 1-.05.087l-9.973 5.812a.1.1 0 0 1-.152-.087m-.559-3.141v3.14a.1.1 0 0 1-.151.086l-9.933-5.81a.11.11 0 0 1-.056-.099V6.436a.1.1 0 0 1 .15-.087l2.44 1.41c-1.455 5.307 1.846 10.993 7.55 13ZM7.013 8.834L4.807 7.561c2.306-3.665 7.094-5.066 10.95-3.186c1.385.676 2.526 1.727 3.39 3.124l.04.062l-2.195 1.268a5.57 5.57 0 0 0-2.429-2.307c-2.603-1.27-5.901-.253-7.552 2.311Zm9.337 5.2c.813-1.371 1.088-2.99.798-4.685l2.255-1.314c1.245 4.86-1.864 10.169-7.14 12.192v-3.072c1.86-.67 3.272-1.747 4.087-3.12ZM4.6 8.018l2.27 1.31c-.225 1.571.112 3.204.951 4.606c.919 1.536 2.225 2.629 3.881 3.25v3.045C6.327 18.25 3.297 13.042 4.601 8.017Zm5.303 2.486l-2.459-1.42c1.52-2.34 4.53-3.268 6.9-2.112A5.1 5.1 0 0 1 16.56 9.08l-2.471 1.427a2.31 2.31 0 0 0-2.03-1.195c-.825 0-1.645.43-2.156 1.192m4.338.522l2.443-1.408c.22 1.51-.043 2.945-.765 4.162c-.735 1.238-1.998 2.224-3.658 2.856v-2.631c1.25-.691 1.968-1.771 1.98-2.979m-5.991 2.65A6.58 6.58 0 0 1 7.34 9.6l2.446 1.412c-.016 1.271.73 2.437 1.917 2.997v2.624a6.98 6.98 0 0 1-3.453-2.956Zm3.853-.148l-.137.073l-.157-.075c-1.023-.504-1.524-1.606-1.557-2.417a2 2 0 0 1 .004-.23a2.15 2.15 0 0 1 1.163-.957c.508-.178 1.034-.153 1.444.071c.6.327.84.797.86.86c.008.156.004.253.004.256c-.038.981-.63 1.863-1.624 2.419"
        />
      </symbol>
      <symbol id="logo-dependabot" viewBox="0 0 24 24">
        <path
          fill="#025e8c"
          d="M10.949.314a1.92 1.92 0 0 1 2.102 0l9.333 6.118c.541.354.866.957.866 1.604v7.928c0 .647-.326 1.25-.866 1.604l-9.333 6.118a1.92 1.92 0 0 1-2.102 0l-9.333-6.118a1.92 1.92 0 0 1-.866-1.604V8.036c0-.647.326-1.25.866-1.604zM12.75 7.5v.75h-6A.75.75 0 0 0 6 9v3h-.5a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25H6v1.5c0 .415.336.75.75.75h10.5a.75.75 0 0 0 .75-.75V15h.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25H18V9a.75.75 0 0 0-.75-.75H13.5V5.5a.25.25 0 0 0-.25-.25H11.5a.25.25 0 0 0-.25.25v1.75c0 .138.112.25.25.25zm3.286 5.089l-1.572 1.572a.303.303 0 0 1-.428 0l-.947-.947a.303.303 0 0 1 0-.428l.322-.322a.303.303 0 0 1 .428 0l.41.411l1.037-1.036a.303.303 0 0 1 .428 0l.322.322a.303.303 0 0 1 0 .428M9.464 14.16a.303.303 0 0 1-.428 0l-.948-.947a.3.3 0 0 1 0-.428l.323-.322a.303.303 0 0 1 .427 0l.412.411l1.036-1.037a.303.303 0 0 1 .427 0l.323.322a.303.303 0 0 1 0 .428z"
        />
      </symbol>
      <symbol id="logo-anthropic" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M13.827 3.52h3.603L24 20h-3.603zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687L6.205 13.48H10.7z"
        />
      </symbol>
      <symbol id="logo-jev" viewBox="0 0 16 16">
        <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3 4.5h10M3 8h6M3 11.5h8" />
      </symbol>
      <symbol id="logo-github" viewBox="0 0 16 16">
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8 0C3.6 0 0 3.6 0 8C0 11.5 2.3 14.5 5.5 15.6C5.9 15.7 6 15.4 6 15.2C6 15 6 14.4 6 13.7C4 14.1 3.5 13.2 3.3 12.8C3.2 12.6 2.8 11.8 2.5 11.7C2.2 11.5 1.8 11.1 2.5 11.1C3.1 11.1 3.6 11.7 3.7 11.9C4.4 13.2 5.6 12.8 6 12.6C6.1 12.1 6.3 11.7 6.6 11.5C4.8 11.3 2.9 10.6 2.9 7.6C2.9 6.7 3.2 6 3.7 5.4C3.7 5.2 3.4 4.4 3.8 3.3C3.8 3.3 4.5 3.1 6 4.1C6.7 4 7.3 3.9 8 3.9C8.7 3.9 9.4 4 10 4.1C11.6 3.1 12.2 3.3 12.2 3.3C12.7 4.4 12.4 5.2 12.3 5.4C12.8 6 13.1 6.7 13.1 7.6C13.1 10.7 11.2 11.3 9.5 11.5C9.8 11.8 10 12.3 10 13C10 14.1 10 14.9 10 15.2C10 15.4 10.2 15.7 10.6 15.6C13.7 14.5 16 11.5 16 8C16 3.6 12.4 0 8 0Z"
        />
      </symbol>
      <symbol id="logo-linkedin" viewBox="0 0 64 64">
        <path
          fill="currentColor"
          d="M54.5 54.5h-9.5v-14.8c0-3.6 0-8.1-4.9-8.1-4.9 0-5.7 3.8-5.7 7.8v15.1h-9.5V24h9.1v4.2h.2a10 10 0 0 1 9-5c9.6 0 11.3 6.4 11.3 14.6l0 16.7ZM14.2 19.8c-3 0-5.5-2.4-5.5-5.5 0-3 2.5-5.5 5.5-5.5 3.1 0 5.5 2.5 5.5 5.5A5.5 5.5 0 0 1 14.2 19.8m4.8 34.7H9.5V24h9.5v30.5ZM59.3 0H4.7C2.1 0 0 2 0 4.6v54.8c0 2.6 2.1 4.6 4.7 4.6h54.6c2.5 0 4.7-2 4.7-4.6V4.6c0-2.6-2.2-4.6-4.7-4.6"
        />
      </symbol>
    </svg>
  );
}
