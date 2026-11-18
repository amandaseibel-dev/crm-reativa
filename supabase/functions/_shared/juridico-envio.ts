// Bloqueio jurídico nos envios de WhatsApp (texto e documento).
//
// Decisão da gestão: aluno com bloqueio jurídico efetivo não recebe envio de cobrança, nem comum,
// nem automático, nem massivo, nem documento de cobrança. Recebimento e leitura não são afetados.
// A regra vive no BANCO (juridico_checar_envio). Esta função só chama o banco ANTES do efeito externo
// e trata QUALQUER falha como bloqueio (fail-closed): erro de rede, de RPC, aluno ausente ou
// autorização ausente impedem o envio.
//
// Sem dependência do Deno: usa só crypto.subtle e TextEncoder, para que os testes rodem no vitest.

// bloqueio = recusa JURIDICA (SQLSTATE proprio JUR01 da checagem: sem autorizacao ou sem aluno identificado).
// NAO usa 42501: esse codigo tambem sai para falta de grant/RLS, que e infraestrutura.
// Nao e falha do gateway. Erro de infraestrutura (rede, RPC indisponivel, excecao) tem bloqueio = false.
export type ChecagemJuridica =
  | { ok: true }
  | { ok: false; erro: string; bloqueio: boolean };

export type RpcChamador = (
  nome: string,
  args: Record<string, unknown>,
) => PromiseLike<{ error: { message: string } | null }>;

// Hash do conteúdo EXATO enviado: SHA-256 em hexadecimal (texto em UTF-8 ou bytes do arquivo).
export async function sha256Hex(dados: string | Uint8Array): Promise<string> {
  const bytes = typeof dados === "string" ? new TextEncoder().encode(dados) : dados;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Hash do DOCUMENTO enviado: bytes + nome + tipo MIME (o gateway recebe os três). Qualquer mudança
// em um deles invalida a autorização.
export async function hashDocumento(nome: string, mime: string, bytes: Uint8Array): Promise<string> {
  const cab = new TextEncoder().encode(`${nome}\u0000${mime}\u0000`);
  const todo = new Uint8Array(cab.length + bytes.length);
  todo.set(cab, 0);
  todo.set(bytes, cab.length);
  return sha256Hex(todo);
}

export async function checarEnvioJuridico(
  rpc: RpcChamador,
  p: {
    alunoId: string | null;
    conversaId: string | null;
    operador: string;
    tipo: "MENSAGEM" | "DOCUMENTO";
    hash: string;
  },
): Promise<ChecagemJuridica> {
  try {
    const { error } = await rpc("juridico_checar_envio", {
      p_aluno: p.alunoId,
      p_conversa: p.conversaId,
      p_operador: p.operador,
      p_tipo: p.tipo,
      p_conteudo_hash: p.hash,
    });
    if (error) {
      return { ok: false, erro: error.message, bloqueio: (error as { code?: string }).code === "JUR01" };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      erro: `não foi possível verificar o bloqueio jurídico; envio não realizado (${String((e as Error)?.message || e)})`,
      bloqueio: false,
    };
  }
}

// Aluno da conversa existente, lido com a chave de serviço. Falha de leitura = recusa.
export async function alunoDaConversa(
  admin: { from: (t: string) => any },
  conversaId: string,
): Promise<{ ok: true; alunoId: string | null } | { ok: false; erro: string; bloqueio: boolean }> {
  try {
    const { data, error } = await admin
      .from("whatsapp_conversas")
      .select("aluno_id")
      .eq("id", conversaId)
      .maybeSingle();
    if (error) return { ok: false, erro: "não foi possível identificar o aluno da conversa; envio não realizado", bloqueio: false };
    return { ok: true, alunoId: (data?.aluno_id as string | null) ?? null };
  } catch {
    return { ok: false, erro: "não foi possível identificar o aluno da conversa; envio não realizado", bloqueio: false };
  }
}

// Mensagem que o operador recebe quando NAO tem acesso a conversa (ou nao esta ativo). Nao revela bloqueio,
// aluno, nem o motivo: so diz que o envio nao e permitido por este fluxo.
export const MENSAGEM_RECUSA_GENERICA = "Envio não permitido por este fluxo para esta conversa.";

// Acesso do operador a conversa, com a MESMA regra de juridico_bloqueio_ids: gestao (usuario_e_gestao) ou
// responsavel da conversa = e-mail do operador. Usuario inativo (app_usuario_ativo) nao tem acesso. Erro = sem acesso.
export async function temAcessoConversa(
  cliente: { rpc: any; from: any },
  conversaId: string | null,
  emailOperador: string,
): Promise<boolean> {
  if (!conversaId || !emailOperador) return false;
  try {
    const { data: ativo, error: erroAtivo } = await cliente.rpc("app_usuario_ativo");
    if (erroAtivo || ativo !== true) return false;
    const { data: gestao, error: erroGestao } = await cliente.rpc("usuario_e_gestao");
    if (!erroGestao && gestao === true) return true;
    const { data, error } = await cliente.from("whatsapp_conversas").select("responsavel_email").eq("id", conversaId).maybeSingle();
    if (error || !data || !data.responsavel_email) return false;
    return String(data.responsavel_email).toLowerCase() === emailOperador.toLowerCase();
  } catch {
    return false;
  }
}

// Recuperacao: envio DESLIGADO por padrao quando a variavel tem qualquer valor que nao seja "falso" explicito.
// Fail-closed: "true", "1", "sim", "on" e digitacao errada desligam o envio. Vazio = ligado (estado normal).
export function envioDesligado(valor: string | undefined): boolean {
  const v = (valor ?? "").trim().toLowerCase();
  if (v === "") return false;
  return !["false", "0", "no", "off", "nao", "não"].includes(v);
}
