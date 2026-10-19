import { useState } from "react";
import { supabase } from "../services/supabase";
import { analisarConfirmacaoF1bNoCRM } from "../services/analiseFinanceiraF1b";

const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

// As duas rotas de `confirmacao_pagamentos_resolver` NAO tem o mesmo peso e a tela
// nunca deve apresenta-las como iguais: as duas ancoram identidade no NOME do aluno,
// e nenhuma delas e prova de pagamento. Quem prova identidade e a ponte
// Santander -> Prime -> CPF, aplicada por cima. Por isso o rotulo diz de onde veio.
const PROVA = {
  VINCULO_GRAVADO: "vínculo gravado na importação",
  CHAVE_MESMA_TRANSACAO: "reconstruído pela transação do import (legado)",
  NAO_DECLARADA: "origem não declarada",
};

// O motor recusa parcela/acordo fora de cobranca, mas o painel jogava `resultados`
// fora e mostrava so "Revisao necessaria · CONJUNTO_COM_EXCECAO" -- o operador via
// que precisava revisar e nao via POR QUE. Aqui o motivo de cada pagamento vira
// frase, com o status que causou a recusa, porque e ele que diz o que fazer.
const MOTIVO_DO_PAGAMENTO = {
  PARCELA_FORA_DE_COBRANCA: "a parcela está fora de cobrança",
  ACORDO_FORA_DE_COBRANCA: "o acordo está fora de cobrança",
  PARCELA_SEM_STATUS: "o status da parcela não foi carregado",
  ACORDO_SEM_STATUS: "o status do acordo não foi carregado",
  ACORDO_NAO_ENCONTRADO: "o número do acordo não existe no CRM (pagamento de mensalidade)",
  ACORDO_AMBIGUO: "mais de um acordo reivindica esse número",
  BOLETO_NAO_ENCONTRADO: "o boleto não existe em nenhuma parcela",
  BOLETO_AMBIGUO: "mais de uma parcela reivindica esse boleto",
  IDENTIFICADORES_CONTRADITORIOS: "acordo e boleto apontam acordos diferentes",
  IDENTIDADE_DIVERGENTE: "o pagamento é de outro aluno",
  PARCELA_FORA_DO_ALUNO: "a parcela é de outro aluno",
  SEM_IDENTIFICADOR_FINANCEIRO: "o pagamento não traz acordo nem boleto",
  IDENTIFICADOR_INVALIDO: "o identificador do pagamento é inválido",
  ACORDO_NAO_PROVADO: "não há acordo provado para esse pagamento",
};

// So as excecoes interessam: o que virou candidato nao precisa de explicacao, e
// repetir linha boa esconderia a ruim.
function excecoes(resultados) {
  return (Array.isArray(resultados) ? resultados : [])
    .filter(r => r?.situacao !== "CANDIDATO_DETERMINISTICO")
    .map(r => {
      const base = MOTIVO_DO_PAGAMENTO[r?.motivo] ?? r?.motivo ?? "motivo não informado";
      const st = r?.status_parcela ?? r?.status_acordo ?? null;
      return st ? `${base} (${st})` : base;
    });
}

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
          motivo: analise.motivo, motivo_resolver: analise.motivo_resolver ?? null,
          motivo_identidade: analise.motivo_identidade ?? null,
          prova: analise.prova_do_conjunto ?? null, qtd: analise.resultados?.length ?? 0,
          excecoes: excecoes(analise.resultados) });
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
                {x.situacao === "CANDIDATOS_IDENTIFICADOS"
                  ? "Candidato identificado — não é pagamento confirmado nem baixa autorizada"
                  : "Revisão necessária"}
                {" · "}{x.motivo} {x.qtd ? `· ${x.qtd} pagamento(s)` : ""}
                {x.prova ? <div style={{ paddingLeft: 12 }}>origem do conjunto: {PROVA[x.prova] ?? x.prova}</div> : null}
                {x.motivo_identidade ? <div style={{ paddingLeft: 12 }}>identidade: {x.motivo_identidade}</div> : null}
                {x.motivo_resolver ? <div style={{ paddingLeft: 12 }}>{x.motivo_resolver}</div> : null}
                {/* POR QUE precisa de revisao, pagamento por pagamento. */}
                {x.excecoes.map((e, i) => (
                  <div key={i} style={{ paddingLeft: 12 }}>⚠ {e}</div>
                ))}
              </div>
            )) : <div>Nenhuma confirmação pendente acessível.</div>}
        </div>
      ) : null}
    </>
  );
}
