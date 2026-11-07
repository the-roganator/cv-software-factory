# Supply chain

Only the pipeline can produce deployable images. Part of the [GitHub plane](README.md#github-plane).

- **v1:** each public repository's `build.yml` builds, attests and signs its images, and three places check the signature.
- **Later:** SLSA provenance, a policy gate with conftest.

```mermaid
flowchart LR
  subgraph build ["build.yml on main"]
    push[Push images to GHCR] --> sbom[Attest an SPDX SBOM per platform, by Syft]
    sbom --> sign[Sign each image by digest, keyless with cosign]
  end
  sign --> watch[Deploy watch proposes only a signed build]
  watch --> check[Deploy pull request's image builds check: signature and SBOM]
  check --> admit["Admission control admits only signed images,<br>and third-party ones named by digest"]
```

## Building and signing

Each public repository's `build.yml` pushes its images to GHCR from `main`. Then a job for each image, side by side, and the only jobs that may ask for the workflow's OIDC token:

1. attests an SPDX SBOM of each platform, made by Syft;
2. signs the image by digest with cosign's keyless signing, signature last.

Fulcio certifies the workflow's identity for minutes, and the signature goes into Rekor, so there is no key to keep or steal.

Each cosign command is tried again, up to four times over about three and a half minutes, when it fails on something that passes: Rekor, Fulcio or GHCR answering 429 or 5xx, or the network failing on the way. Any other failure fails the job at once. An image whose job still fails is in GHCR unsigned, and the deploy watch does not propose it until the job is run again. A try again can leave a second signature or SBOM by the same identity, which changes nothing: each place that checks accepts any one that verifies.

## Whose signature

The signature names the workflow, the repository and the ref. Only `build.yml` on `main` of the repository that builds the image is trusted, compared whole.

## Where it is checked

| Where | Checks |
|---|---|
| The deploy watch ([GitHub worker](GITHUB-WORKER.md#signatures)) | Proposes only a signed build |
| A deploy pull request's `image builds` check | Verifies the signature and the SBOM of each image it moves to, with `cosign` |
| [Admission control](ADMISSION-CONTROL.md) | Admits nothing else, but the third-party images it names by digest, in `factory`, `runners`, `website` and `scoreboard` |
