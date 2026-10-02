// SHA-256 do arquivo importado, em hexadecimal minúsculo.
//
// É a chave de idempotência da captura de presença (J3/I1): a extração é
// identificada pelo CONTEÚDO, não pelo nome nem pelo horário do upload. Reenviar
// o mesmo arquivo reencontra a extração que já existe em vez de criar uma
// observação temporal nova — é o que impede a sequência falsa
// "TOTAL A · TOTAL A de novo · TOTAL B" ser lida como três momentos.
//
// Os dois importadores (ImportacaoAcordos e Borderos) usam ESTA função, não uma
// cópia: hash diferente para o mesmo arquivo quebraria a idempotência entre os
// dois fluxos sem ninguém perceber.
//
// `crypto.subtle` exige contexto seguro (https ou localhost). A aplicação roda
// em https; fora disso esta função lança, e a RPC recusa por falta de hash — a
// importação financeira segue normal, só a presença não é registrada.

/**
 * @param {ArrayBuffer|Uint8Array} dados Conteúdo bruto do arquivo.
 * @returns {Promise<string>} SHA-256 em hex minúsculo (64 caracteres).
 */
export async function hashArquivo(dados) {
  if (dados == null) throw new Error("hashArquivo: conteúdo ausente.");
  // Normaliza para ArrayBuffer: FileReader devolve ArrayBuffer, File.arrayBuffer()
  // também, mas quem já converteu para Uint8Array passaria a view — e a view
  // pode ser uma janela de um buffer maior, o que mudaria o hash.
  const buffer =
    dados instanceof Uint8Array
      ? dados.byteOffset === 0 && dados.byteLength === dados.buffer.byteLength
        ? dados.buffer
        : dados.slice().buffer
      : dados;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
