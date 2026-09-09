// ATÉ QUANDO O NÚMERO DA TELA VALE.
//
// A carteira só enxerga até o vencimento mais novo que entrou por borderô. Em
// 08/09/2026 isso era 10/07: julho, agosto e setembro não estavam na base
// porque os borderôs seguintes ainda não tinham chegado da Ulbra.
//
// Sem isso escrito, os R$ 42,5 milhões da tela são lidos como a inadimplência
// de hoje — e não são, são a de até 10/07. Quem decide meta, comissão ou
// prioridade em cima do número precisa saber de qual data ele é. E, com a data
// na tela, o atraso do borderô deixa de ser invisível e vira conversa com a
// Ulbra.
//
// DUAS FORMAS. `selo` é o chip discreto para ficar ao lado de um total;
// `bloco` é a faixa da Saúde da Carteira, que explica o que falta entrar.
//
// O limite de 35 dias existe porque o borderô é mensal: 30 dias mais folga
// para o arquivo ser gerado e importado.
import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const DIAS_PARA_VIRAR_AVISO = 35;

function dataCurta(iso) {
  if (!iso) return null;
  const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
  if (!ano || !mes || !dia) return null;
  return `${dia}/${mes}/${ano}`;
}

export default function SeloDataDeCorte({ variante = "selo" }) {
  const [dados, setDados] = useState(null);

  useEffect(() => {
    let vivo = true;
    supabase
      .rpc("base_data_de_corte")
      .then(({ data, error }) => {
        if (!vivo || error) return;
        setDados(data || null);
      })
      .catch(() => { /* informativo: falhar calado é melhor que derrubar a tela */ });
    return () => { vivo = false; };
  }, []);

  const cobreAte = dataCurta(dados?.cobre_ate);
  if (!cobreAte) return null;

  const dias = Number(dados?.dias_sem_bordero);
  const atrasado = Number.isFinite(dias) && dias > DIAS_PARA_VIRAR_AVISO;
  const ref = dados?.ultimo_bordero_ref ?? "—";
  const recebidoEm = dataCurta(dados?.ultimo_bordero_em) ?? "—";

  if (variante === "bloco") {
    return (
      <div role="status" style={atrasado ? S.blocoAviso : S.blocoCalmo}>
        <div style={S.blocoTitulo}>
          {atrasado ? "⚠ A base está desatualizada" : "Estado da base"}
        </div>
        <div style={S.blocoTexto}>
          Os números desta tela cobrem vencimentos <strong>até {cobreAte}</strong>.
          {" "}Último borderô recebido: <strong>ref. {ref}</strong>, em {recebidoEm}
          {Number.isFinite(dias) ? ` (há ${dias} dias)` : ""}.
          {atrasado
            ? " O que venceu depois dessa data ainda não entrou — o total abaixo é um piso, não a inadimplência de hoje."
            : ""}
        </div>
      </div>
    );
  }

  const titulo = atrasado
    ? `Último borderô há ${dias} dias (ref. ${ref}, em ${recebidoEm}). O que venceu depois de ${cobreAte} ainda não entrou na base.`
    : `Último borderô: ref. ${ref}, recebido em ${recebidoEm}.`;

  return (
    <span role="status" title={titulo} style={atrasado ? S.seloAviso : S.seloCalmo}>
      {atrasado ? "⚠ " : ""}Números até {cobreAte}
      {atrasado ? ` · ${dias} dias sem borderô` : ""}
    </span>
  );
}

const selo = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 9px",
  borderRadius: "var(--rv-raio-pequeno, 6px)",
  fontSize: 12,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  cursor: "help",
};

const bloco = {
  marginTop: 14,
  padding: "12px 14px",
  borderRadius: "var(--rv-raio, 10px)",
  fontSize: 13,
  lineHeight: 1.5,
};

const S = {
  seloCalmo: {
    ...selo,
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-borda-suave)",
    color: "var(--rv-texto-suave)",
  },
  seloAviso: {
    ...selo,
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-alerta)",
    color: "var(--rv-alerta)",
    fontWeight: 600,
  },
  blocoCalmo: {
    ...bloco,
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-borda-suave)",
    color: "var(--rv-texto-suave)",
  },
  blocoAviso: {
    ...bloco,
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-alerta)",
    borderLeft: "3px solid var(--rv-alerta)",
    color: "var(--rv-texto)",
  },
  blocoTitulo: {
    fontWeight: 600,
    marginBottom: 4,
    color: "var(--rv-texto)",
  },
  blocoTexto: { color: "var(--rv-texto-suave)" },
};
