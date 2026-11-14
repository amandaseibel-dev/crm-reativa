// Retorno do OAuth da Mensageria ULBRA: a Mensageria devolve o navegador do
// OPERADOR aqui com `code` e `state`. Esta página só entrega os dois à função
// `ulbra-conversa` (conexao_concluir), que troca o código e guarda os tokens
// cifrados. Nenhum token passa pela tela.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import "./ulbra.css";
import { conexaoConcluir } from "../utils/ulbraConversaCliente";

export default function UlbraConectado() {
  const [params] = useSearchParams();
  const [situacao, setSituacao] = useState("processando"); // processando | ok | erro
  const [detalhe, setDetalhe] = useState(null);
  const code = params.get("code");
  const state = params.get("state");
  const erroUlbra = params.get("error");

  useEffect(() => {
    let ativo = true;
    (async () => {
      if (erroUlbra) { setSituacao("erro"); setDetalhe(`A Mensageria recusou a conexão: ${erroUlbra}`); return; }
      if (!code || !state) { setSituacao("erro"); setDetalhe("Retorno sem código ou sem state."); return; }
      const r = await conexaoConcluir(code, state);
      if (!ativo) return;
      if (r?.ok) { setSituacao("ok"); setDetalhe(r.pessoa ? `Conectado como ${r.pessoa}.` : "Conectado."); }
      else { setSituacao("erro"); setDetalhe(r?.motivo || r?.erro || "Não foi possível concluir a conexão."); }
    })();
    return () => { ativo = false; };
  }, [code, state, erroUlbra]);

  return (
    <div className="ulbra-pagina" data-testid="ulbra-conectado" data-situacao={situacao}>
      <h1 className="ulbra-titulo">Conexão com a Mensageria ULBRA</h1>
      {situacao === "processando" ? <p>Concluindo a conexão…</p> : null}
      {situacao === "ok" ? <p className="ulbra-aviso ulbra-aviso--verde">{detalhe} Suas respostas pela Central sairão em seu nome.</p> : null}
      {situacao === "erro" ? <p className="ulbra-aviso ulbra-aviso--vermelho" role="alert">{detalhe}</p> : null}
      <p><Link className="ulbra-link" to="/central-ulbra?visao=mensageria">Voltar para a Central ULBRA</Link></p>
    </div>
  );
}
