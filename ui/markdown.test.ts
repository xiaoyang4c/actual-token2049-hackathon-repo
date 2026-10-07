import {describe, expect, test} from 'bun:test';
import {inline, renderMarkdown} from './markdown.js';

describe('Coworker answer Markdown', () => {
  test('escapes HTML everywhere, including in code, tables, and headings', () => {
    const html = renderMarkdown([
      '## <img src=x onerror=alert(1)> title',
      '<script>alert(1)</script> and [a link](javascript:alert(1))',
      '| <b>A</b> | B |', '| --- | --- |', '| <i>1</i> | `<code>` |',
      '```', '<script>x</script>', '```',
    ].join('\n'));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>&lt;code&gt;</code>');
  });

  test('renders the forms a Coworker answer uses', () => {
    const html = renderMarkdown([
      '## Tally contract draft: Lot 1',
      '**Paper contract (SIMULATED).** No real money moves.',
      '',
      '**In short**',
      '- The buyer pays **4,000 test USDM**.',
      '*   The seller delivers.',
      '',
      '### Where the money goes',
      '| Milestone | Price |',
      '| :--- | ---: |',
      '| 1. Lot 1 | 4,000 test USDM |',
      '',
      '1. **The parties negotiate.** Up to 2 days.',
      '2. **A mediator decides.**',
      '',
      '---',
      '',
      'Template `physical-objective-spec`.',
      '_Prepared by Tally\'s contract engine._',
    ].join('\n'));
    expect(html).toContain('<h3>Tally contract draft: Lot 1</h3>');
    expect(html).toContain('<p><strong>Paper contract (SIMULATED).</strong> No real money moves.</p>');
    expect(html).toContain('<ul class="md-list"><li>The buyer pays <strong>4,000 test USDM</strong>.</li><li>The seller delivers.</li></ul>');
    expect(html).toContain('<h4>Where the money goes</h4>');
    expect(html).toContain('<th scope="col">Milestone</th><th scope="col">Price</th>');
    expect(html).toContain('<td>1. Lot 1</td><td>4,000 test USDM</td>');
    expect(html).toContain('<ol class="md-list"><li><strong>The parties negotiate.</strong> Up to 2 days.</li><li><strong>A mediator decides.</strong></li></ol>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<code>physical-objective-spec</code>');
    expect(html).toContain('<em>Prepared by Tally&#39;s contract engine.</em>');
  });

  test('underscores inside words and code stay literal', () => {
    expect(inline('seal_id and partial_release')).toBe('seal_id and partial_release');
    expect(inline('`a_b_c` and *x*')).toBe('<code>a_b_c</code> and <em>x</em>');
  });

  test('consecutive lines stay on separate lines', () => {
    expect(renderMarkdown('**Next step:** Sign.\nYou can still change the remedy.')).toBe('<p><strong>Next step:</strong> Sign.<br>You can still change the remedy.</p>');
  });
});
