import { useState } from "react";
import { supabase } from "../services/supabase";
import { analisarConfirmacaoF1bNoCRM } from "../services/analiseFinanceiraF1b";

const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

// Painel de diagnostico a pedido da gestao. So leitura; nao aprova baixas ou modifica fila.
// Busca confirmacoes pelo ID do aluno exclusivamente para ENCONTRAR as linhas a examinar;
// o motor exige vinculo por pagamento e CPF via Prime para recomendar qualquer candidato.
//
// ESCOPO: lista as confirmacoes pendentes DO ALUNO, em qualquer data -- nao o mes
// filtrado na fila. Por isso cada linha vem com a data, senao o resultado parece
// ser do periodo da tela e nao e. Medido em 19/10/2026: nenhum aluno tem mais de
// 3 confirmacoes abertas (214 tem 1, 27 tem 2, 2 tem 3), entao o custo por clique
// e de poucas consultas e o teto de 20 abaixo nunca e atingido na pratica.
export default function DiagnosticoF1b({ alunoId }) {
  const [aberto, setAberto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [itens, setItens] = useState([]);
  const [erro, setErro] = useState("");
  async function consultar() {
    setAberto(true); setOcupado(true); setErro(""); setItens([]);
    try {
      const { data, error } = await supabase.from("solicitacoes_confirmacao_pagamento")
        .select("id,data_pagamento").eq("aluno_id", String(alunoId))
        .eq("status", "AGUARDANDO_CONFIRMACAO").order("data_pagamento", { ascending: false }).limit(21);
      if (error) throw error;
      if (!Array.isArray(data) || data.length > 20) throw new Error("CONSULTA_INCOMPLETA");
      const resultados = [];
      for (const c of data) {
        const analise = await analisarConfirmacaoF1bNoCRM(supabase, c.id);
        resultados.push({ id: c.id, data: c.data_pagamento, situacao: analise.situacao,
          motivo: analise.motivo, qtd: analise.resultados?.length ?? 0 });
      }
      setItens(resultados);
    } catch {
      setErro("Não foi possível concluir a leitura. Nenhum vínculo foi proposto.");
    } finally {
      setOcupado(false);
    }
  }
  return (
    <>
      <button type="button" onClick={() => aberto ? setAberto(false) : consultar()}
        disabled={ocupado} style={{ marginLeft: 6, fontSize: 11 }}
        title="Diagnóstico financeiro F1.b, sem baixa e sem alterar registros">
        {ocupado ? "Analisando…" : aberto ? "Ocultar análise F1.b" : "Análise F1.b"}
      </button>
      {aberto && !ocupado ? (
        <div role="status" style={{ marginTop: 4, fontSize: 12 }}>
          <strong>Somente leitura; não comprova pagamento nem baixa.</strong>
          <div>Confirmações pendentes deste aluno, em qualquer data — não só o período filtrado.</div>
          {erro ? <div>{erro}</div> :
            itens.length ? itens.map(x => (
              <div key={x.id}>
                {curta(x.data)}{" · "}
                {x.situacao === "CANDIDATOS_IDENTIFICADOS" ? "Candidato identificado" : "Revisão necessária"}
                {" · "}{x.motivo} {x.qtd ? `· ${x.qtd} pagamento(s)` : ""}
              </div>
            )) : <div>Nenhuma confirmação pendente acessível.</div>}
        </div>
      ) : null}
    </>
  );
}
