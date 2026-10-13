import { handler } from "../netlify/functions/microsoft-calendar.mjs";
import { runNetlifyHandler } from "../vercel-adapter.mjs";

export default function microsoftCalendar(request, response) {
  return runNetlifyHandler(handler, request, response);
}
