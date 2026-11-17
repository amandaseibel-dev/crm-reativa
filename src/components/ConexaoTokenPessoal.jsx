// Cadastro do token pessoal da Mensageria (piloto). O valor do token:
// - fica só no estado do componente e é apagado logo após a resposta, sucesso ou não;
// - nunca vai para localStorage, sessionStorage, URL ou log;
// - segue para a função por HTTPS e é cifrado no backend. A resposta não traz o valor.
import { useState } from "react";

export const VALIDADES = [7, 30, 60, 90];

export const ROTULO_MOTIVO_TOKEN = {
  TOKEN_FORMATO_INVALIDO: "O token colado não tem o formato esperado. Confira se copiou o valor inteiro, sem espaços.",
  VALIDADE_NAO_PERMITIDA: "Escolha uma validade de 7, 30, 60 ou 90 dias.",
  TOKEN_RECUSADO_PELA_MENSAGERIA: "A Mensageria recusou este token. Crie outro em MCP › Tokens pessoais e cole de novo.",
  IDENTIDADE_DIVERGENTE: "Este token pertence a outra pessoa. Use um token criado na sua própria conta da Mensageria.",
  MENSAGERIA_INDISPONIVEL: "A Mensageria não respondeu agora. Tente de novo em instantes.",
  CONEXAO_OAUTH_ATIVA: "Você já tem uma conexão OAuth ativa. Desconecte-a antes de cadastrar o token pessoal, para não deixar acesso válido sem controle.",
  AUDITORIA_NAO_GRAVADA:"Não foi possível registrar a auditoria, então nada foi guardado. Tente de novo.",
  FALHA_CADASTRO_TOKEN: "Não foi possível cadastrar o token agora. Nada foi guardado.",
};

export default function ConexaoTokenPessoal({ onCadastrar }) {
  const [token, setToken] = useState("");
  const [validade, setValidade] = useState(30);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState(null);

  async function enviar(evento) {
    evento.preventDefault();
    const valor = token;
    setOcupado(true);
    setAviso(null);
    let r;
    try {
      r = await onCadastrar(valor, validade);
    } catch {
      r = { ok: false, motivo: "FALHA_CADASTRO_TOKEN" };
    } finally {
      // Apaga o valor do estado em qualquer desfecho.
      setToken("");
      setOcupado(false);
    }
    if (r?.ok) {
      setAviso({ tipo: "ok", texto: "Token cadastrado. Envio e leitura usam a sua conta a partir de agora." });
    } else {
      setAviso({ tipo: "erro", texto: ROTULO_MOTIVO_TOKEN[r?.motivo] || ROTULO_MOTIVO_TOKEN.FALHA_CADASTRO_TOKEN });
    }
  }

  return (
    <form data-campo="token-pessoal" onSubmit={enviar} autoComplete="off" className="ulbra-token-pessoal">
      <label>
        Token pessoal da Mensageria
        <input
          type="password"
          name="token_mensageria"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={ocupado}
        />
      </label>
      <label>
        Validade
        <select value={validade} onChange={(e) => setValidade(Number(e.target.value))} disabled={ocupado}>
          {VALIDADES.map((d) => <option key={d} value={d}>{d} dias</option>)}
        </select>
      </label>
      <button type="submit" className="ulbra-link" data-campo="cadastrar-token" disabled={ocupado || !token.trim()}>
        {ocupado ? "Cadastrando..." : "Cadastrar token"}
      </button>
      <p className="ulbra-conv-ajuda">
        Crie o token em MCP › Tokens pessoais na Mensageria, com as permissões de ver clientes, ver atendimentos, ler conversas e enviar mensagens. Ele é mostrado uma vez.
      </p>
      {aviso ? <p role={aviso.tipo === "erro" ? "alert" : "status"} data-campo="token-aviso">{aviso.texto}</p> : null}
    </form>
  );
}
