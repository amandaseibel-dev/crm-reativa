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
