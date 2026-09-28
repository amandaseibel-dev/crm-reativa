// Aba Resultados do Preventivo.
//
// A honestidade desta tela é a parte mais importante dela. A API do Prime não
// entrega evento de pagamento, data de pagamento nem saldo em aberto — os 13
// campos do extrato foram conferidos ao vivo em 28/09/2026 e nenhum é situação.
// O que medimos é REDUÇÃO DE SALDO, que mistura pagamento, cancelamento, bolsa
// e renegociação.
//
// Por isso "valor recebido" aparece como indisponível, com o motivo, em vez de
// ser preenchido com a redução de saldo. Trocar um pelo outro transformaria
// cancelamento em recuperação — é o mesmo erro que já custou caro na cobrança.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta } from "../../utils/preventivoFormato";
import { AvisoAtualizacao } from "./AbaCarteira";
import { csv } from "../../utils/preventivo";

const ROTULO_MOVIMENTO = {
  QUITACAO_OBSERVADA: "Saldo foi a zero",
  REDUCAO_SALDO_OBSERVADA: "Saldo diminuiu",
  AUMENTO_SALDO_OBSERVADO: "Saldo aumentou (encargo)",
  MUDANCA_DE_PORTADOR: "Mudou de portador",
  AUSENTE_NO_EXTRATO: "Sumiu do extrato",
  RETORNO_AO_EXTRATO: "Voltou ao extrato",
};

function baixar(nome, conteudo) {
  const url = URL.createObjectURL(new Blob(["﻿" + conteudo], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  URL.revokeObjectURL(url);
}

export default function AbaResultados({ carteira }) {
  const [res, setRes] = useState(null);
  const [situacao, setSituacao] = useState(null);
  const [erro, setErro] = useState("");

  const buscar = useCallback(() => Promise.all([
    supabase.rpc("preventivo_resultados", { p_carteira_id: carteira.id }),
    supabase.rpc("preventivo_sinc_situacao", { p_carteira_id: carteira.id }),
  ]), [carteira.id]);

  const aplicar = useCallback(([r, s]) => {
    if (r.error) { setErro(r.error.message); return; }
    setErro(""); setRes(r.data);
    if (!s.error) setSituacao(s.data);
  }, []);

  useEffect(() => {
    let vivo = true;
    buscar().then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  async function exportar(movimento, nome) {
    const { data, error } = await supabase.rpc("preventivo_titulos", {
      p_carteira_id: carteira.id, p_movimento: movimento, p_limite: 5000,
    });
    if (error) { setErro(error.message); return; }
    baixar(nome, csv(data || [], [
      { rotulo: "aluno", valor: (l) => l.aluno },
      { rotulo: "matricula", valor: (l) => l.matricula },
      { rotulo: "titulo", valor: (l) => l.documento },
      { rotulo: "competencia", valor: (l) => l.competencia },
      { rotulo: "vencimento", valor: (l) => l.vencimento },
      { rotulo: "valor_entrada", valor: (l) => l.valor_inicial },
      { rotulo: "saldo_atual", valor: (l) => l.saldo_atual },
      { rotulo: "reducao_observada", valor: (l) => l.reducao },
      { rotulo: "situacao_origem", valor: (l) => l.situacao_origem },
      { rotulo: "lote", valor: (l) => l.lote },
    ]));
  }

  if (erro) return <div style={S.erroBox}>{erro}</div>;
  if (!res) return <p style={S.muted}>Carregando…</p>;

  const t = res.totais;
  const rec = res.reconciliacao;
  const fechamento = Number(rec.valor_inicial) - Number(rec.reducao_observada)
    + Number(rec.aumento_observado) - Number(rec.saldo_atual);
  const percentual = Number(rec.valor_inicial) > 0
    ? (Number(rec.reducao_observada) / Number(rec.valor_inicial)) * 100 : 0;

  return (
    <div>
      <AvisoAtualizacao situacao={situacao} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
        <Cartao rotulo="Alunos na carteira" valor={t.alunos} />
        <Cartao rotulo="Títulos" valor={t.titulos} />
        <Cartao rotulo="Valor em aberto na entrada" valor={moeda(t.valor_inicial)} />
        <Cartao rotulo="Saldo atual" valor={t.saldo_atual === null ? "não consultado" : moeda(t.saldo_atual)} />
        <Cartao rotulo="Na janela preventiva" valor={t.na_janela} />
        <Cartao rotulo="Fora da janela (histórico)" valor={t.fora_da_janela} />
      </div>

      {/* O número que a gestão mais quer é o que a fonte não dá. Está escrito. */}
      <div style={{ ...S.card, padding: 20, marginTop: 18, borderLeft: "4px solid var(--rv-ambar-borda)" }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Valor recebido: não disponível pela fonte</h2>
        <p style={{ ...S.muted, marginTop: 8, maxWidth: 820 }}>{res.recebido.motivo}</p>
        <p style={{ ...S.muted, marginTop: 8, maxWidth: 820 }}>
          O que está medido abaixo é <strong>redução de saldo observada</strong>. Ela inclui
          pagamento, mas também cancelamento, bolsa e renegociação — por isso não é
          apresentada como dinheiro recebido.
        </p>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Movimento observado, por tipo</h2>
        <table style={{ ...S.tabela, marginTop: 12 }}>
          <thead><tr>
            <th style={S.th}>O que foi observado</th><th style={S.thNum}>Títulos</th><th style={S.thNum}>Valor</th>
          </tr></thead>
          <tbody>
            {Object.keys(res.movimento).length === 0 ? (
              <tr><td style={S.td} colSpan={3}>
                Nenhum movimento ainda. O primeiro ciclo de atualização é só a foto
                inicial — movimento aparece a partir do segundo.
              </td></tr>
            ) : Object.entries(res.movimento).map(([tipo, m]) => (
              <tr key={tipo}>
                <td style={S.td}>{ROTULO_MOVIMENTO[tipo] || tipo}</td>
                <td style={S.tdNum}>{m.titulos}</td>
                <td style={S.tdNum}>
                  {["MUDANCA_DE_PORTADOR", "AUSENTE_NO_EXTRATO", "RETORNO_AO_EXTRATO"].includes(tipo)
                    ? "—" : moeda(m.valor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>A conta fecha</h2>
        <p style={{ ...S.muted, marginTop: 6 }}>
          entrada − redução observada + aumento observado = saldo atual
        </p>
        <table style={{ ...S.tabela, marginTop: 12 }}>
          <tbody>
            <tr><td style={S.td}>Valor em aberto na entrada</td><td style={S.tdNum}>{moeda(rec.valor_inicial)}</td></tr>
            <tr><td style={S.td}>− Redução de saldo observada</td><td style={S.tdNum}>{moeda(rec.reducao_observada)}</td></tr>
            <tr><td style={S.td}>+ Aumento de saldo observado</td><td style={S.tdNum}>{moeda(rec.aumento_observado)}</td></tr>
            <tr><td style={{ ...S.td, fontWeight: 800 }}>= Saldo atual</td><td style={{ ...S.tdNum, fontWeight: 800 }}>{moeda(rec.saldo_atual)}</td></tr>
            <tr>
              <td style={S.td}>Diferença</td>
              <td style={{ ...S.tdNum, color: Math.abs(fechamento) < 0.01 ? "var(--rv-verde-escuro)" : "var(--rv-erro)" }}>
                {moeda(fechamento)}
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ ...S.muted, marginTop: 10 }}>
          Redução sobre a entrada: <strong>{percentual.toFixed(1)}%</strong> — medida sobre o
          valor em aberto de {dataCurta(res.carteira?.venc_de)} a {dataCurta(res.carteira?.venc_ate)},
          desde a entrada de cada título na carteira até hoje ({dataCurta(res.hoje)}).
          {t.ausentes_no_extrato > 0
            ? ` ${t.ausentes_no_extrato} título(s) sumiram do extrato do Prime e ficaram FORA desta conta — sumir não é pagar.`
            : ""}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12, marginTop: 14 }}>
        <Cartao rotulo="Alunos com algum título reduzido" valor={res.alunos.com_alguma_reducao} />
        <Cartao rotulo="Alunos com todos os títulos zerados" valor={res.alunos.com_todos_quitados} />
        <Cartao rotulo="Alunos sem nenhum movimento" valor={res.alunos.sem_movimento} />
      </div>

      {res.por_dia?.length > 0 && (
        <div style={{ ...S.card, padding: 20, marginTop: 14 }}>
          <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Redução de saldo por dia</h2>
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
            O dia é o da <strong>observação</strong>, não o do pagamento: a fonte não informa
            data de pagamento.
          </p>
        </div>
      )}

      <div style={{ ...S.barra, marginTop: 16 }}>
        <button style={S.btnGhost} onClick={() => exportar("com_reducao", "preventivo-com-reducao.csv")}>
          Exportar quem teve redução
        </button>
        <button style={S.btnGhost} onClick={() => exportar("pendente", "preventivo-pendentes.csv")}>
          Exportar pendentes
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
