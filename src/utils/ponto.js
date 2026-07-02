import { supabase } from "../services/supabase";

const CHAVE_SESSAO = "ponto_login_registrado";

export async function registrarLoginSeNecessario(email, nome) {
  if (!email) return;
  if (sessionStorage.getItem(CHAVE_SESSAO) === email) return;

  await supabase.from("ponto_operadores").insert({
    email,
    nome: nome || email,
    tipo: "LOGIN",
  });

  sessionStorage.setItem(CHAVE_SESSAO, email);
}

export async function registrarLogout(email, nome) {
  if (!email) return;

  await supabase.from("ponto_operadores").insert({
    email,
    nome: nome || email,
    tipo: "LOGOUT",
  });

  sessionStorage.removeItem(CHAVE_SESSAO);
}

export async function registrarEventoPonto(email, nome, tipo) {
  if (!email) return;

  await supabase.from("ponto_operadores").insert({
    email,
    nome: nome || email,
    tipo,
  });
}
