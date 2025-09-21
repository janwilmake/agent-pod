/*
  Warnings:

  - A unique constraint covering the columns `[css_web_id]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "css_pod_base_url" TEXT,
ADD COLUMN     "css_web_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_css_web_id_key" ON "public"."users"("css_web_id");
