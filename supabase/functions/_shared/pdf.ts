// Validação do PDF que o operador anexa na Central.
//
// POR QUE ISTO É UM MÓDULO SEPARADO: é a única peça de segurança deste caminho
// e precisa de teste. A Edge Function roda em Deno e não tem suíte no projeto;
// aqui a lógica fica pura, sem rede e sem Supabase, e o vitest da raiz exercita
// exatamente o mesmo código que a função importa.
//
// A REGRA CENTRAL: quem decide o tipo são os BYTES. `file.type` vem do
// navegador, a extensão vem do nome — os dois são texto que qualquer um
// escreve. Um executável renomeado para .pdf passa pelos dois e morre aqui.
//
// Nesta primeira versão só passa `application/pdf`. Lista fechada: qualquer
// outro formato é decisão nova, não efeito colateral.

export const MIME_PDF = "application/pdf";

// 16 MB: o mesmo teto que a Edge de mídia de ENTRADA já usa em produção, e
// abaixo do teto duro do bucket (20 MB).
//
// POR QUE NÃO OS 10 MB DO GATEWAY: aquele limite existe porque a mídia que
// ENTRA viaja em base64 dentro de um POST, e base64 cresce ~33%. O caminho de
// saída não usa base64 — o gateway busca o arquivo por URL assinada —, então a
// razão daquele número não se aplica aqui.
export const LIMITE_BYTES = 16 * 1024 * 1024;

export const LIMITE_NOME = 120;

// "%PDF-" — os cinco bytes que abrem todo PDF válido.
const ASSINATURA_PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

export function ehPdf(dados: Uint8Array): boolean {
  if (dados.length < ASSINATURA_PDF.length) return false;
  for (let i = 0; i < ASSINATURA_PDF.length; i++) {
    if (dados[i] !== ASSINATURA_PDF[i]) return false;
  }
  return true;
}

// Nome de arquivo vindo do navegador é dado do usuário: pode trazer caminho
// ("../../etc/passwd"), separador do Windows, caractere de controle ou 300
// caracteres. Nada disso entra no histórico — e o nome NÃO decide o caminho no
// Storage, que é aleatório de qualquer forma.
export function nomeSeguro(nome: string): string {
  const base = String(nome || "")
    .split(/[/\\]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!base) return "documento.pdf";

  const semExt = base.replace(/\.pdf$/i, "");
  if (!semExt) return "documento.pdf";

  // Corta o MIOLO, não o fim: o fim costuma ser o que distingue um arquivo do
  // outro ("...-parcela-12"), e é o que o aluno usa para saber o que recebeu.
  const cortado = semExt.length > LIMITE_NOME
    ? `${semExt.slice(0, LIMITE_NOME - 21)}...${semExt.slice(-18)}`
    : semExt;
  return `${cortado}.pdf`;
}

export type Recusa = { ok: false; erro: string };
export type Aprovacao = { ok: true; nome: string; mime: string; tamanho: number };

// Um portão só, com todas as recusas. A mensagem é a que o operador lê — por
// isso diz o que aconteceu, não o nome técnico da checagem.
export function validarPdf(nome: string, dados: Uint8Array): Recusa | Aprovacao {
  if (dados.length === 0) return { ok: false, erro: "arquivo vazio" };

  if (dados.length > LIMITE_BYTES) {
    const mb = (dados.length / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      erro: `arquivo de ${mb} MB — o limite é ${LIMITE_BYTES / 1024 / 1024} MB`,
    };
  }

  // Extensão errada é recusada ANTES de olhar os bytes: um .docx legítimo não é
  // "PDF corrompido", é outro formato — e nesta versão só PDF entra.
  if (!/\.pdf$/i.test(String(nome || "").trim())) {
    return { ok: false, erro: "só PDF nesta versão" };
  }

  if (!ehPdf(dados)) {
    return {
      ok: false,
      erro: "o arquivo não é um PDF de verdade (o conteúdo não confere com a extensão)",
    };
  }

  return { ok: true, nome: nomeSeguro(nome), mime: MIME_PDF, tamanho: dados.length };
}

// Caminho imprevisível no bucket, no mesmo padrão da mídia de entrada: ano/mês
// para manutenção humana, nome aleatório para que ninguém adivinhe o arquivo do
// aluno ao lado. O nome ORIGINAL nunca vira caminho.
export function caminhoNovo(aleatorio: string): string {
  const agora = new Date();
  const ano = agora.getUTCFullYear();
  const mes = String(agora.getUTCMonth() + 1).padStart(2, "0");
  return `saida/${ano}/${mes}/${aleatorio}.pdf`;
}
