#!/usr/bin/env node
/**
 * auth.mjs — autenticação inicial para o MCP reativa-readonly.
 * Envia OTP para o email de gestão e armazena o refresh_token no macOS Keychain.
 * Execute uma vez: SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_EMAIL=... node auth.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import * as readline from "readline/promises";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EMAIL = process.env.SUPABASE_EMAIL;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !EMAIL) {
  console.error(
    "Variáveis obrigatórias não definidas:\n" +
    "  export SUPABASE_URL=https://xxx.supabase.co\n" +
    "  export SUPABASE_ANON_KEY=eyJ...\n" +
    "  export SUPABASE_EMAIL=seu@email.com\n"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`Enviando OTP para ${EMAIL}...`);
const { error: sendError } = await supabase.auth.signInWithOtp({
  email: EMAIL,
  options: { shouldCreateUser: false },
});

if (sendError) {
  console.error(`Erro ao enviar OTP: ${sendError.message}`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const otp = (await rl.question("Código recebido por e-mail: ")).trim();
rl.close();

const { data, error: verifyError } = await supabase.auth.verifyOtp({
  email: EMAIL,
  token: otp,
  type: "email",
});

if (verifyError || !data.session) {
  console.error(`OTP inválido ou expirado: ${verifyError?.message ?? "sem sessão retornada"}`);
  process.exit(1);
}

try {
  execSync(
    `security add-generic-password -s reativa-mcp -a refresh_token -U -w "${data.session.refresh_token}"`,
    { stdio: "ignore" }
  );
  console.log("\n✓ Sessão armazenada no macOS Keychain (serviço: reativa-mcp).");
  console.log(`  Usuário: ${data.user?.email}`);
  console.log("  O MCP renovará a sessão automaticamente a cada uso.");
  console.log("  Para revogar: security delete-generic-password -s reativa-mcp -a refresh_token");
} catch (err) {
  console.error("Erro ao salvar no Keychain:", err.message);
  process.exit(1);
}
