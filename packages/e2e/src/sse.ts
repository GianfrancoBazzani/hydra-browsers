/** Returns the data of each event of a text/event-stream body. Data lines are joined with '\n'. */
export function parseSseData(body: string): string[] {
  const events: string[] = [];
  for (const block of body.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).replace(/^ /, ''));
    if (data.length > 0) {
      events.push(data.join('\n'));
    }
  }
  return events;
}
