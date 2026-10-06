// Aba Resultados do Preventivo.
//
// A honestidade desta tela é a parte mais importante dela. A API do Prime não
// entrega evento de recebimento, data de recebimento nem valor em aberto — os
// 13 campos do extrato foram conferidos ao vivo em 28/09/2026 e nenhum deles
// informa situação.
//
// O que medimos é ALTERAÇÃO DO VALOR DO TÍTULO NA FONTE (`netAmount`). Uma
// queda desse valor pode vir de um recebimento, mas também de cancelamento,
// bolsa ou renegociação — e a API não diz qual.
//
// Por isso "valor recebido" aparece como indisponível, com o motivo, em vez de
// ser preenchido com a queda do valor na fonte. Trocar um pelo outro
// transformaria cancelamento em recuperação — é o mesmo erro que já custou caro
// na cobrança.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta } from "../../utils/preventivoFormato";
import { AvisoAtualizacao } from "./AbaCarteira";
import { csv } from "../../utils/preventivo";

const ROTULO_ALTERACAO = {
  VALOR_FONTE_ZEROU: "O valor do título zerou na fonte",
  VALOR_FONTE_CAIU: "O valor do título caiu na fonte",
  VALOR_FONTE_SUBIU: "O valor do título subiu na fonte (encargo)",
  MUDANCA_DE_PORTADOR: "Mudou de portador",
  AUSENTE_NO_EXTRATO: "Sumiu do extrato",
  RETORNO_AO_EXTRATO: "Voltou ao extrato",
  VINCULO_AMBIGUO: "Mais de um candidato no Prime",
  VINCULO_RESOLVIDO: "Vínculo com o Prime resolvido",
};

const ROTULO_VINCULO = {
  UNICO: "Com vínculo único no Prime",
  AMBIGUO: "Ambíguo (mais de um candidato)",
  NAO_ENCONTRADO: "Não encontrado no Prime",
  PENDENTE: "Ainda não consultado",
};

function baixar(nome, conteudo) {
  const url = URL.createObjectURL(new Blob(["﻿" + conteudo], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  URL.revokeObjectURL(url);
}

// A etapa da jornada. Mesmos rótulos da aba Ações — o eixo é o mesmo.
const CONTEXTOS = {
  PROXIMO_VENCIMENTO: "Próximo ao vencimento",
  BOLETO_VENCIDO: "Boleto vencido",
  SEM_CONTEXTO: "Sem contexto (antes do campo existir)",
};

export default function AbaResultados({ carteira }) {
  const [res, setRes] = useState(null);
  const [situacao, setSituacao] = useState(null);
  const [porContexto, setPorContexto] = useState(null);
  const [periodo, setPeriodo] = useState({ de: "", ate: "" });
  const [erro, setErro] = useState("");

  const buscar = useCallback(() => Promise.all([
    supabase.rpc("preventivo_resultados", { p_carteira_id: carteira.id }),
    supabase.rpc("preventivo_sinc_situacao", { p_carteira_id: carteira.id }),
    // Período vazio = sem limite daquele lado. O corte é pela data de criação
    // da ação, não pelo vencimento do título.
    supabase.rpc("preventivo_resultados_por_contexto", {
      p_carteira_id: carteira.id,
      p_de: periodo.de || null,
      p_ate: periodo.ate || null,
    }),
  ]), [carteira.id, periodo.de, periodo.ate]);

  const aplicar = useCallback(([r, s, c]) => {
    if (r.error) { setErro(r.error.message); return; }
    setErro(""); setRes(r.data);
    if (!s.error) setSituacao(s.data);
    if (!c.error) setPorContexto(c.data);
  }, []);

  useEffect(() => {
    let vivo = true;
    buscar().then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  async function exportar(alteracao, nome) {
    const { data, error } = await supabase.rpc("preventivo_titulos", {
      p_carteira_id: carteira.id, p_alteracao: alteracao, p_limite: 5000,
    });
    if (error) { setErro(error.message); return; }
    baixar(nome, csv(data || [], [
      { rotulo: "aluno", valor: (l) => l.aluno },
      { rotulo: "matricula", valor: (l) => l.matricula },
      { rotulo: "titulo", valor: (l) => l.documento },
      { rotulo: "competencia", valor: (l) => l.competencia },
      { rotulo: "vencimento", valor: (l) => l.vencimento },
      { rotulo: "venc_origem", valor: (l) => l.vencimento_origem },
      { rotulo: "saldo_informado_pelo_arquivo", valor: (l) => l.saldo_informado },
      { rotulo: "valor_na_fonte", valor: (l) => l.valor_fonte },
      { rotulo: "vinculo_com_o_prime", valor: (l) => l.vinculo },
      { rotulo: "situacao_origem", valor: (l) => l.situacao_origem },
      { rotulo: "lote", valor: (l) => l.lote },
    ]));
  }

  if (erro) return <div style={S.erroBox}>{erro}</div>;
  if (!res) return <p style={S.muted}>Carregando…</p>;

  const t = res.totais;
  const c = res.conferencia;
  const fechamento = Number(c.valor_na_fonte_no_primeiro_ciclo) - Number(c.queda_registrada)
    + Number(c.alta_registrada) - Number(c.valor_na_fonte_agora);

  return (
    <div>
      <AvisoAtualizacao situacao={situacao} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
        <Cartao rotulo="Alunos na carteira" valor={t.alunos} />
        <Cartao rotulo="Títulos" valor={t.titulos} />
        <Cartao rotulo="Saldo informado pelo arquivo" valor={moeda(t.saldo_informado)} />
        <Cartao rotulo="Na janela preventiva" valor={t.na_janela} />
        <Cartao rotulo="Fora da janela (histórico)" valor={t.fora_da_janela} />
        <Cartao rotulo="Nunca consultados no Prime" valor={t.sem_sinc} />
      </div>

      <PorContexto dados={porContexto} periodo={periodo} setPeriodo={setPeriodo} />

      {/* O número que a gestão mais quer é o que a fonte não dá. Está escrito. */}
      <div style={{ ...S.card, padding: 20, marginTop: 18, borderLeft: "4px solid var(--rv-ambar-borda)" }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>
          Confirmação de pagamento: não disponível pela fonte
        </h2>
        <p style={{ ...S.muted, marginTop: 8, maxWidth: 860 }}>{res.recebido.motivo}</p>
        <p style={{ ...S.muted, marginTop: 8, maxWidth: 860 }}>
          O que está medido abaixo é <strong>alteração do valor do título na fonte</strong>{" "}
          (<code>netAmount</code>). Isso <strong>não é saldo em aberto</strong> e{" "}
          <strong>não é dinheiro recebido</strong>: a queda pode vir de pagamento, mas também
          de cancelamento, bolsa ou renegociação.
        </p>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>
          De quantos títulos o Prime consegue falar
        </h2>
        <p style={{ ...S.muted, marginTop: 6, maxWidth: 860 }}>
          O relatório da ULBRA não traz identificador de título, então o vínculo é resolvido
          por matrícula + vencimento atual. Onde há mais de um candidato, o título fica
          pendente — nada é escolhido por suposição.
        </p>
        <table style={{ ...S.tabela, marginTop: 12 }}>
          <thead><tr><th style={S.th}>Vínculo com o Prime</th><th style={S.thNum}>Títulos</th></tr></thead>
          <tbody>
            {Object.entries(res.vinculo || {}).map(([k, n]) => (
              <tr key={k}>
                <td style={S.td}>{ROTULO_VINCULO[k] || k}</td>
                <td style={S.tdNum}>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Alteração de valor na fonte, por tipo</h2>
        <table style={{ ...S.tabela, marginTop: 12 }}>
          <thead><tr>
            <th style={S.th}>O que foi observado</th><th style={S.thNum}>Títulos</th><th style={S.thNum}>Valor</th>
          </tr></thead>
          <tbody>
            {Object.keys(res.alteracoes || {}).length === 0 ? (
              <tr><td style={S.td} colSpan={3}>
                Nenhuma alteração ainda. O primeiro ciclo é só a foto inicial — alteração
                aparece a partir do segundo.
              </td></tr>
            ) : Object.entries(res.alteracoes).map(([tipo, m]) => (
              <tr key={tipo}>
                <td style={S.td}>{ROTULO_ALTERACAO[tipo] || tipo}</td>
                <td style={S.tdNum}>{m.titulos}</td>
                <td style={S.tdNum}>
                  {["MUDANCA_DE_PORTADOR", "AUSENTE_NO_EXTRATO", "RETORNO_AO_EXTRATO",
                    "VINCULO_AMBIGUO", "VINCULO_RESOLVIDO"].includes(tipo) ? "—" : moeda(m.valor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>A conferência fecha</h2>
        <p style={{ ...S.muted, marginTop: 6 }}>
          Só entram os títulos com vínculo único. É uma conferência do que a FONTE diz,
          não um demonstrativo financeiro.
        </p>
        <table style={{ ...S.tabela, marginTop: 12 }}>
          <tbody>
            <tr><td style={S.td}>Valor na fonte no primeiro ciclo</td>
                <td style={S.tdNum}>{moeda(c.valor_na_fonte_no_primeiro_ciclo)}</td></tr>
            <tr><td style={S.td}>− Quedas registradas</td><td style={S.tdNum}>{moeda(c.queda_registrada)}</td></tr>
            <tr><td style={S.td}>+ Altas registradas</td><td style={S.tdNum}>{moeda(c.alta_registrada)}</td></tr>
            <tr><td style={{ ...S.td, fontWeight: 800 }}>= Valor na fonte agora</td>
                <td style={{ ...S.tdNum, fontWeight: 800 }}>{moeda(c.valor_na_fonte_agora)}</td></tr>
            <tr>
              <td style={S.td}>Diferença</td>
              <td style={{ ...S.tdNum, color: Math.abs(fechamento) < 0.01 ? "var(--rv-verde-escuro)" : "var(--rv-erro)" }}>
                {moeda(fechamento)}
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ ...S.muted, marginTop: 10 }}>
          Saldo informado pelo arquivo na entrada: <strong>{moeda(t.saldo_informado)}</strong>,
          para vencimentos de {dataCurta(res.carteira?.venc_de)} a {dataCurta(res.carteira?.venc_ate)}.
          Esse número e o valor na fonte <strong>não se somam nem se subtraem</strong>: vêm de
          fontes diferentes, com definições diferentes.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12, marginTop: 14 }}>
        <Cartao rotulo="Alunos com algum título que caiu" valor={res.alunos.com_alguma_queda} />
        <Cartao rotulo="Alunos com todos os títulos zerados na fonte" valor={res.alunos.com_todos_zerados} />
        <Cartao rotulo="Alunos sem nenhuma alteração" valor={res.alunos.sem_alteracao} />
      </div>

      {res.por_dia?.length > 0 && (
        <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
          <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Queda de valor na fonte, por dia</h2>
          <table style={{ ...S.tabela, marginTop: 12 }}>
            <thead><tr><th style={S.th}>Dia</th><th style={S.thNum}>Títulos</th><th style={S.thNum}>Valor</th></tr></thead>
            <tbody>
              {res.por_dia.map((d) => (
                <tr key={d.dia}>
                  <td style={S.td}>{dataCurta(d.dia)}</td>
                  <td style={S.tdNum}>{d.titulos}</td>
                  <td style={S.tdNum}>{moeda(d.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ ...S.muted, marginTop: 8, fontSize: 12 }}>
            O dia é o da <strong>observação</strong>, não o de um pagamento: a fonte não informa
            data de pagamento.
          </p>
        </div>
      )}

      <div style={{ ...S.barra, marginTop: 16 }}>
        <button style={S.btnGhost} onClick={() => exportar("caiu", "preventivo-valor-caiu.csv")}>
          Exportar quem teve queda de valor
        </button>
        <button style={S.btnGhost} onClick={() => exportar("sem_alteracao", "preventivo-sem-alteracao.csv")}>
          Exportar quem não teve alteração
        </button>
      </div>
    </div>
  );
}

function Cartao({ rotulo, valor }) {
  return (
    <div style={{ background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-texto-fraco)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{rotulo}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: "var(--rv-tinta)", marginTop: 4 }}>{valor ?? 0}</div>
    </div>
  );
}

// Resultado por etapa da jornada e por canal, com corte opcional de período.
// A palavra é REGULARIZADO: nunca "pago", nunca "recuperado". A definição vem
// do banco e viaja junto.
function PorContexto({ dados, periodo, setPeriodo }) {
  if (!dados) return null;
  const contextos = dados.contextos || {};
  const chaves = Object.keys(contextos);

  return (
    <div style={{ ...S.card, padding: 20, marginTop: 18 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between" }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Resultado por contexto e canal</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 11, fontWeight: 700 }}>Ações criadas de</label>
            <input type="date" style={{ ...S.input, minWidth: 0 }} value={periodo.de}
                   onChange={(e) => setPeriodo({ ...periodo, de: e.target.value })} />
          </div>
          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 11, fontWeight: 700 }}>até</label>
            <input type="date" style={{ ...S.input, minWidth: 0 }} value={periodo.ate}
                   onChange={(e) => setPeriodo({ ...periodo, ate: e.target.value })} />
          </div>
          {(periodo.de || periodo.ate) && (
            <button style={S.btnGhost} onClick={() => setPeriodo({ de: "", ate: "" })}>
              Limpar período
            </button>
          )}
        </div>
      </div>

      <p style={{ ...S.muted, marginTop: 6, fontSize: 12.5 }}>{dados.definicao}</p>

      {chaves.length === 0 ? (
        <p style={{ ...S.muted, marginTop: 12 }}>
          Nenhuma ação no período escolhido.
        </p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginTop: 14 }}>
          {chaves.map((k) => (
            <div key={k} style={{ ...S.card, padding: 16 }}>
              <div style={{ ...S.cardNome, fontSize: 14 }}>{CONTEXTOS[k] || k}</div>
              <Metricas d={contextos[k]} />
              {Object.entries(contextos[k].canais || {}).map(([canal, m]) => (
                <details key={canal} style={{ marginTop: 10 }}>
                  <summary style={{ ...S.muted, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                    {canal === "WHATSAPP" ? "WhatsApp" : "E-mail"} · {m.acoes} ação(ões)
                  </summary>
                  <Metricas d={m} />
                </details>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Metricas({ d }) {
  return (
    <>
      <Linha rotulo="Ações" valor={d.acoes} />
      <Linha rotulo="Com envio confirmado" valor={d.acoes_com_envio_confirmado} />
      <Linha rotulo="Alunos acionados" valor={d.alunos_acionados} />
      <Linha rotulo="Títulos acionados" valor={d.titulos_acionados} />
      <Linha rotulo="Valor acionado" valor={moeda(d.valor_acionado)} />
      <Linha rotulo="Continuam em aberto" valor={d.continuam_em_aberto} />
      <Linha rotulo="Regularizados entre remessas" valor={d.regularizados_entre_remessas} />
      <Linha rotulo="Valor regularizado" valor={moeda(d.valor_regularizado)} />
      <Linha rotulo="Taxa de regularização"
             valor={d.taxa_regularizacao === null ? "—" : `${d.taxa_regularizacao}%`} />
      {d.aguardando_proxima_remessa > 0 && (
        <p style={{ ...S.muted, marginTop: 8, fontSize: 11.5 }}>
          {d.aguardando_proxima_remessa} ação(ões) ainda sem remessa seguinte para comparar.
        </p>
      )}
    </>
  );
}

function Linha({ rotulo, valor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 6, fontSize: 12.5 }}>
      <span style={S.muted}>{rotulo}</span>
      <strong>{valor ?? "—"}</strong>
    </div>
  );
}
