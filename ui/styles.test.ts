import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The desk root uses mode-paper / mode-live / mode-mixed / mode-none for the
// top rail. A bare .mode-mixed rule also matches that root and turns the page
// into a two-column grid.
describe("operator desk css", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8")

  test("banner rules are scoped to the mode section", () => {
    const bare = (name: string) => new RegExp(`(^|\\n)\\.${name}\\s*\\{`)
    expect(css).not.toMatch(bare("mode-mixed"))
    expect(css).not.toMatch(bare("mode-paper"))
    expect(css).not.toMatch(bare("mode-live"))
    expect(css).not.toMatch(bare("mode-none"))
    expect(css).toContain(".mode.mode-mixed")
    expect(css).toContain(".mode.mode-paper")
    expect(css).toContain(".mode.mode-live")
    expect(css).toContain(".mode.mode-none")
  })
})
