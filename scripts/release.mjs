// Publishes the installer built by `npm run dist` as a GitHub release, using the GitHub CLI (`gh`).
// The installer, its blockmap and latest.yml must come from the same build, or auto-update rejects the download.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'))
const { owner, repo } = build.publish[0]
const tag = `v${version}`
const files = [`release/RimDeck-Setup-${version}.exe`, `release/RimDeck-Setup-${version}.exe.blockmap`, 'release/latest.yml']
for (const f of files) if (!existsSync(f)) throw new Error(`Missing ${f} — run npm run dist first`)
if (!readFileSync('release/latest.yml', 'utf8').includes(`version: ${version}`)) throw new Error('latest.yml is from another version')

const gh = (...args) => execFileSync('gh', [...args, '--repo', `${owner}/${repo}`], { stdio: 'inherit' })
let exists = true
try {
  execFileSync('gh', ['release', 'view', tag, '--repo', `${owner}/${repo}`], { stdio: 'ignore' })
} catch {
  exists = false
}
if (exists) gh('release', 'upload', tag, ...files, '--clobber')
else {
  const notes = existsSync('RELEASE_NOTES.md') ? ['--notes-file', 'RELEASE_NOTES.md'] : ['--generate-notes']
  gh('release', 'create', tag, ...files, '--title', `RimDeck ${version}`, ...notes)
}
console.log(`Published ${tag}`)
