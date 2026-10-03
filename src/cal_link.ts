// "Add to calendar" without any permission: a Google Calendar link and an .ics file the owner taps to add the event themselves.
const utc = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

export interface LinkEvent { title: string; startMs: number; endMs: number; location: string | null }

export function googleLink(e: LinkEvent): string {
  const q = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${utc(e.startMs)}/${utc(e.endMs)}` });
  if (e.location) q.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function icsFile(e: LinkEvent, now: number): string {
  const uid = `${utc(now)}-${Math.abs([...e.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}@rafiki`;
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Rafiki//EN", "METHOD:PUBLISH", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${utc(now)}`, `DTSTART:${utc(e.startMs)}`, `DTEND:${utc(e.endMs)}`, `SUMMARY:${esc(e.title)}`, ...(e.location ? [`LOCATION:${esc(e.location)}`] : []), "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}
