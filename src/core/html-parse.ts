type RootChildElement = {
  closeTag: string;
  content: string;
  innerContent: string;
  nthOfType: number;
  openTag: string;
  pathSegment: string;
  selfClosing: boolean;
  tag: string;
};

const findTagEnd = (content: string, start: number) => {
  let quote: null | string = null;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
};

const readTag = (tagSource: string) => {
  const match = tagSource.match(/^<\/?\s*([a-zA-Z][\w:.-]*)/);
  return match?.[1]?.toLowerCase();
};

const isSelfClosingTag = (tagSource: string) => /\/\s*>$/.test(tagSource);

const findElementEnd = ({
  content,
  openEnd,
  startTag,
}: {
  content: string;
  openEnd: number;
  startTag: string;
}) => {
  if (isSelfClosingTag(content.slice(0, openEnd + 1))) return openEnd + 1;

  let cursor = openEnd + 1;
  let depth = 1;
  while (cursor < content.length) {
    const nextOpen = content.indexOf("<", cursor);
    if (nextOpen === -1) return content.length;
    if (content.startsWith("<!--", nextOpen)) {
      const commentEnd = content.indexOf("-->", nextOpen + 4);
      cursor = commentEnd === -1 ? content.length : commentEnd + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", nextOpen)) {
      const cdataEnd = content.indexOf("]]>", nextOpen + 9);
      cursor = cdataEnd === -1 ? content.length : cdataEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(content, nextOpen);
    if (tagEnd === -1) return content.length;
    const tagSource = content.slice(nextOpen, tagEnd + 1);
    const tag = readTag(tagSource);
    if (tag === startTag) {
      if (tagSource.startsWith("</")) {
        depth -= 1;
        if (depth === 0) return tagEnd + 1;
      } else if (!isSelfClosingTag(tagSource)) {
        depth += 1;
      }
    }
    cursor = tagEnd + 1;
  }
  return content.length;
};

const parseRootChildElements = (content: string): RootChildElement[] => {
  const children: RootChildElement[] = [];
  const siblingCounts = new Map<string, number>();
  let cursor = 0;

  while (cursor < content.length) {
    const nextOpen = content.indexOf("<", cursor);
    if (nextOpen === -1) break;
    if (
      content.startsWith("<!--", nextOpen) ||
      content.startsWith("<?", nextOpen) ||
      content.startsWith("<!", nextOpen)
    ) {
      const closeToken = content.startsWith("<!--", nextOpen) ? "-->" : ">";
      const closeIndex = content.indexOf(closeToken, nextOpen + 2);
      cursor =
        closeIndex === -1 ? content.length : closeIndex + closeToken.length;
      continue;
    }

    const openEnd = findTagEnd(content, nextOpen);
    if (openEnd === -1) break;
    const tagSource = content.slice(nextOpen, openEnd + 1);
    if (tagSource.startsWith("</")) {
      cursor = openEnd + 1;
      continue;
    }
    const tag = readTag(tagSource);
    if (!tag) {
      cursor = openEnd + 1;
      continue;
    }

    const elementEnd = findElementEnd({
      content: content.slice(nextOpen),
      openEnd: openEnd - nextOpen,
      startTag: tag,
    });
    const rawElement = content.slice(nextOpen, nextOpen + elementEnd);
    const openTag = content.slice(nextOpen, openEnd + 1);
    const selfClosing = isSelfClosingTag(openTag);
    const closeStart = selfClosing
      ? -1
      : rawElement.toLowerCase().lastIndexOf(`</${tag}`);
    const innerContent =
      !selfClosing && closeStart >= 0
        ? rawElement.slice(openTag.length, closeStart)
        : "";
    const closeTag =
      !selfClosing && closeStart >= 0 ? rawElement.slice(closeStart) : "";
    const nthOfType = (siblingCounts.get(tag) ?? 0) + 1;
    siblingCounts.set(tag, nthOfType);
    children.push({
      closeTag,
      content: rawElement,
      innerContent,
      nthOfType,
      openTag,
      pathSegment: `${tag}:nth-of-type(${nthOfType})`,
      selfClosing,
      tag,
    });
    cursor = nextOpen + elementEnd;
  }

  return children;
};

export type { RootChildElement };
export { findTagEnd, parseRootChildElements };
