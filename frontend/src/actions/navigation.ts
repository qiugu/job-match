"use server";

import { redirect } from "@/lib/navigation";

export async function GoDashboardAction() {
  redirect("/app/dashboard");
}
export async function GoResumesAction() {
  redirect("/app/dashboard/resumes");
}
