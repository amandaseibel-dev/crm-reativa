import { useState } from "react";
import { supabase } from "../services/supabase";
import { analisarConfirmacaoF1bNoCRM } from "../services/analiseFinanceiraF1b";

// Painel de diagnostico a pedido da gestao. So leitura; nao aprova baixas ou modifica fila.
// Busca confirmacoes pelo ID do aluno exclusivamente para ENCONTRAR as linhas a examinar;
// o motor exige vinculo por pagamento e CPF via Prime para recomendar qualquer candidato.
export default function DiagnosticoF1b({ alunoId }) {
  const [aberto, setAberto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [itens, setItens] = useState([]);
  const [erro, setErro] = useState("");
  async function consultar() {
    setAberto(true); setOcupado(true); setErro(""); setItens([]);
    try {
      const { data, error } = await supabase.from("solicitacoes_confirmacao_pagamento")
        .select("id").eq("aluno_id", String(alunoId))
        .eq("status", "AGUARDANDO_CONFIRMACAO").limit(21);
      if (error) throw error;
      if (!Array.isArray(data) || data.length > 20) throw new Error("CONSULTA_INCOMPLETA");
      const resultados = [];
      for (const c of data) {
        const analise = await analisarConfirmacaoF1bNoCRM(supabase, c.id);
        resultados.push({ id: c.id, situacao: analise.situacao, motivo: analise.motivo,
          qtd: analise.resultados?.length ?? 0 });
      }
      setItens(resultados);
    } catch {
      setErro("Não foi possível concluir a leitura. Nenhum vínculo foi proposto.");
    } finally {
      setOcupado(false);
    }
  }
  return (
    <div style={{ marginTop: 5, fontSize: 12 }}>
      <button type="button" onClick={() => aberto ? setAberto(false) : consultar()}
        disabled={ocupado} title="Diagnóstico financeiro F1.b, sem baixa e sem alterar registros">
        {ocupado ? "Analisando…" : aberto ? "Ocultar análise F1.b" : "Análise F1.b"}
      </button>
      {aberto && !ocupado ? (
        <div role="status" style={{ marginTop: 5 }}>
          <strong>Somente leitura; não comprova pagamento nem baixa.</strong>
          {erro ? <div>{erro}</div> :
            itens.length ? itens.map(x => (
              <div key={x.id}>
                {x.situacao === "CANDIDATOS_IDENTIFICADOS" ? "Candidato identificado" : "Revisão necessária"}
                {" · "}{x.motivo} {x.qtd ? `· ${x.qtd} pagamento(s)` : ""}
              </div>
            )) : <div>Nenhuma confirmação pendente acessível.</div>}
        </div>
      ) : null}
    </div>
  );
}
