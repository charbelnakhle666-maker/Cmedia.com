import { handler } from "../netlify/functions/appointments.mjs";
import { runNetlifyHandler } from "../vercel-adapter.mjs";

export default function appointments(request, response) {
  return runNetlifyHandler(handler, request, response);
}
