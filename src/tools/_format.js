/**
 * Shared MCP response formatting helper.
 * All tool files use this instead of manually constructing MCP responses.
 */
function clean(value) {
  return String(value || '').trim();
}

function joinSections(sections) {
  return sections.filter(Boolean).join('\n\n').trim();
}

function formatHeadlineList(obj) {
  const headlines = Array.isArray(obj?.headlines) ? obj.headlines : [];
  if (headlines.length === 0) return null;
  const lines = headlines.map((item) => {
    const prefix = item?.id != null ? `${item.id}. ` : '- ';
    const headline = clean(item?.headline) || clean(item?.title) || 'Untitled';
    const date = clean(item?.date);
    return date ? `${prefix}${headline} (${date})` : `${prefix}${headline}`;
  });
  return lines.join('\n');
}

function formatMarkdownDetails(obj) {
  const details = Array.isArray(obj?.details)
    ? obj.details
    : Array.isArray(obj?.documents)
      ? obj.documents.flatMap((document) => document?.details || [])
      : [];
  const markdownBlocks = details
    .filter((item) => item?.has_substantive_content !== false)
    .map((item) => clean(item?.markdown))
    .filter(Boolean);
  if (markdownBlocks.length === 0) return null;
  return markdownBlocks.join('\n\n---\n\n');
}

export function toContextText(obj) {
  if (typeof obj === 'string') return obj;
  if (obj == null) return '';

  const directMarkdown = clean(obj.markdown);
  if (directMarkdown) return directMarkdown;

  if (obj?.action === 'financials_get' && clean(obj?.markdown)) {
    return clean(obj.markdown);
  }

  if (obj?.action === 'documents_get') {
    const sections = [];
    const heading = clean(obj?.ticker) ? `# Documents: ${obj.ticker}` : '# Documents';
    sections.push(heading);
    if (obj?.document_count != null) sections.push(`Visible documents: ${obj.document_count}`);
    const details = Array.isArray(obj?.documents)
      ? obj.documents.flatMap((document) => document?.details || [])
      : [];
    const markdownBlocks = details
      .filter((item) => item?.has_substantive_content !== false)
      .map((item) => clean(item?.markdown))
      .filter(Boolean);
    if (markdownBlocks.length > 0) sections.push(markdownBlocks.join('\n\n---\n\n'));
    if (markdownBlocks.length === 0) sections.push('No extractable document content was found in the currently visible cards.');
    return joinSections(sections);
  }

  if (obj?.action === 'news_detail') {
    const detailMarkdown = formatMarkdownDetails(obj);
    if (detailMarkdown) return detailMarkdown;
  }

  if (obj?.action === 'news_list' || obj?.action === 'news_flow') {
    const headlineList = formatHeadlineList(obj);
    const selectedArticle = clean(obj?.selected_article?.markdown);
    return joinSections([headlineList, selectedArticle]);
  }

  const nestedMarkdown = formatMarkdownDetails(obj);
  if (nestedMarkdown) return nestedMarkdown;

  return JSON.stringify(obj, null, 2);
}

export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}
