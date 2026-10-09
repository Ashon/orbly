/**
 * Replies mix Slack mrkdwn (*bold*, ~strike~, <url|label>, • lists) with
 * Markdown. The UI normalizes them to Markdown. Code blocks and inline code are
 * left alone. The Markdown component keeps line breaks as they are, like Slack.
 * (markdown.tsx)
 */
export function slackToMarkdown(text: string): string {
  let inCode = false
  return text
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('```')) {
        inCode = !inCode
        return line
      }
      if (inCode) return line
      return (
        line
          // Slack bullet lines become Markdown lists
          .replace(/^(\s*)[•◦▪‣]\s+/, '$1- ')
          .split(/(`[^`]*`)/)
          .map((part, i) =>
            i % 2
              ? part
              : part
                  .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, '[$2]($1)')
                  .replace(/<(https?:\/\/[^|>\s]+)>/g, '$1')
                  .replace(
                    /(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g,
                    '$1**$2**'
                  )
                  .replace(
                    /(^|[^~\w])~(?!\s)([^~\n]+?)(?<!\s)~(?![~\w])/g,
                    '$1~~$2~~'
                  )
          )
          .join('')
      )
    })
    .join('\n')
}
