/**
 * 답변은 Slack mrkdwn(*굵게*, ~취소~, <url|라벨>, • 목록)과 Markdown 이 섞여 있다.
 * 화면에서는 Markdown 으로 맞춰 보여 준다. 코드 블록과 인라인 코드는 건드리지 않는다.
 * 줄바꿈은 Slack 처럼 그대로 보이도록 Markdown 컴포넌트가 처리한다. (markdown.tsx)
 */
export function slackToMarkdown(text: string): string {
  let inCode = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) {
        inCode = !inCode;
        return line;
      }
      if (inCode) return line;
      return (
        line
          // Slack 글머리 기호 줄은 Markdown 목록으로
          .replace(/^(\s*)[•◦▪‣]\s+/, "$1- ")
          .split(/(`[^`]*`)/)
          .map((part, i) =>
            i % 2
              ? part
              : part
                  .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
                  .replace(/<(https?:\/\/[^|>\s]+)>/g, "$1")
                  .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "$1**$2**")
                  .replace(/(^|[^~\w])~(?!\s)([^~\n]+?)(?<!\s)~(?![~\w])/g, "$1~~$2~~")
          )
          .join("")
      );
    })
    .join("\n");
}
