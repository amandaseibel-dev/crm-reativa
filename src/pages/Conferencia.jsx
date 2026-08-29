// Conferencia: uma porta para as quatro listas que perguntam a mesma coisa --
// entrou dinheiro, o que fazemos?
//
// Amanda: "criar uma fila unica, sem suposicoes e sim com quem realmente pagou"
// e, sobre o escopo, "tem a parte dos termos e cartoes que nao podemos mexer".
//
// O QUE ENTRA e o que tem ZERO acoplamento com termo e cartao -- conferido
// arquivo a arquivo antes de mexer:
//
//   tela                    termos   cartoes/links
//   Pagamentos sem aluno       0        0     -> entra
//   Quitacao sugerida          0        0     -> entra
//   Possivel acordo            0        0     -> entra
//   Conciliacao Santander      0        0     -> entra
//   Painel ADM                 3       24     -> FICA FORA (e a tela de termos e cartoes)
//   Fila de Baixas             0        5     -> FICA FORA (fluxo do cartao)
//   Confirmacao de Pagamento   0        1     -> FICA FORA (uso diario; o risco nao paga o ganho)
//
// POR QUE E UMA PORTA E NAO UMA LISTA UNICA. As quatro tem formatos diferentes
// (uma lista pagamentos, tres listam alunos) e as tres antigas ja funcionam.
// Reescrever as quatro num modelo comum seria trocar codigo provado por codigo
// novo para ganhar pouco. O que a gestao pediu -- um lugar so e um numero que
// diga se o dia acabou -- se resolve com o seletor e o contador; cada lista
// segue sendo mantida por si.
//
// OS CONTADORES NAO BLOQUEIAM A ABERTURA. `conferencia_contadores` leva ~2,5 s
// (quitacao_sugerida e possivel_acordo chamam aluno_saldo_pendente_detalhe por
// linha). A aba abre no tipo escolhido na hora e preenche os numeros quando
// chegarem.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import ConciliacaoSantander from "./ConciliacaoSantander";
import PagamentosSemAluno from "./PagamentosSemAluno";
import QuitacaoSugerida from "./QuitacaoSugerida";
import PossivelAcordo from "./PossivelAcordo";

const TIPOS = [
  {
    chave: "AJUSTAR", rotulo: "Ajustar", campo: "ajustar",
    dica: "Entrou no extrato do Santander e o aluno ainda tem saldo.",
  },
  {
    chave: "VINCULAR", rotulo: "Vincular", campo: "vincular",
    dica: "Dinheiro no extrato que não achou dono.",
  },
  {
    chave: "QUITAR", rotulo: "Quitar", campo: "quitar",
    dica: "Pagou o suficiente para encerrar.",
  },
  {
    chave: "ACORDO", rotulo: "Oferecer acordo", campo: "acordo",
    dica: "Pagou alguma coisa, ainda deve e não tem acordo.",
  },
];

export default function Conferencia() {
  const [tipo, setTipo] = useState("AJUSTAR");
  const [contadores, setContadores] = useState(null);
  const [contando, setContando] = useState(false);

  const contar = useCallback(async () => {
    setContando(true);
    const { data } = await supabase.rpc("conferencia_contadores");
    setContadores(data || null);
    setContando(false);
  }, []);

  useEffect(() => { contar(); }, [contar]);

  const total = contadores
    ? TIPOS.reduce((s, t) => s + Number(contadores[t.campo] || 0), 0)
    : null;

  const atual = TIPOS.find((t) => t.chave === tipo);

  return (
    <div>
      <div style={topo}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h1 style={titulo}>Conferência</h1>
          <span style={resumo}>
            {total === null
              ? (contando ? "contando…" : "—")
              : total === 0 ? "nada pendente" : <>faltam <b>{total}</b></>}
          </span>
        </div>
        <button type="button" onClick={contar} style={btnGhost} disabled={contando}>
          {contando ? "Contando…" : "Recontar"}
        </button>
      </div>

      <div style={tipos}>
        {TIPOS.map((t) => {
          const on = t.chave === tipo;
          const n = contadores ? Number(contadores[t.campo] || 0) : null;
          return (
            <button
              key={t.chave}
              type="button"
              onClick={() => setTipo(t.chave)}
              style={{ ...chip, ...(on ? chipOn : null) }}
              aria-pressed={on}
              title={t.dica}
            >
              <span>{t.rotulo}</span>
              <span style={{ ...badge, ...(on ? badgeOn : null) }}>
                {n === null ? "…" : n}
              </span>
            </button>
          );
        })}
      </div>

      {atual ? <p style={dica}>{atual.dica}</p> : null}

      <div>
        {tipo === "AJUSTAR" && <ConciliacaoSantander />}
        {tipo === "VINCULAR" && <PagamentosSemAluno />}
        {tipo === "QUITAR" && <QuitacaoSugerida />}
        {tipo === "ACORDO" && <PossivelAcordo />}
      </div>
    </div>
  );
}

const topo = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  gap: 14, flexWrap: "wrap", padding: "16px 16px 0",
};
const titulo = { margin: 0, fontSize: 21, fontWeight: 800, color: "#0f172a" };
const resumo = { fontSize: 13.5, color: "#475569", fontVariantNumeric: "tabular-nums" };
const btnGhost = {
  background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8,
  padding: "6px 12px", fontSize: 12.5, fontWeight: 700, color: "#334155", cursor: "pointer",
};
const tipos = { display: "flex", gap: 7, flexWrap: "wrap", padding: "12px 16px 0" };
const chip = {
  display: "flex", alignItems: "center", gap: 8,
  background: "#fff", border: "1px solid #cbd5e1", borderRadius: 10,
  padding: "7px 14px", fontSize: 13, fontWeight: 800, color: "#475569", cursor: "pointer",
};
const chipOn = { background: "#0f172a", borderColor: "#0f172a", color: "#fff" };
const badge = {
  background: "#f1f5f9", color: "#334155", borderRadius: 999,
  padding: "1px 9px", fontSize: 11.5, fontWeight: 800, fontVariantNumeric: "tabular-nums",
};
const badgeOn = { background: "#334155", color: "#fff" };
const dica = { margin: "10px 16px 0", fontSize: 12.5, color: "#64748b" };
