import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import ControleLinksPagamento from "../pages/ControleLinksPagamento";
import FilaFinanceiro from "../pages/FilaFinanceiro";
import FilaConfirmacaoPagamento from "../pages/FilaConfirmacaoPagamento";
import FilaAdmTermos from "../pages/FilaAdmTermos";

function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

export default function CentralPagamentos() {
  const [aba, setAba] = useState("links");
  const [c, setC] = useState(null);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let ativo = true;
    supabase.rpc("dashboard_central_contadores").then(({ data }) => { if (ativo) setC(data); });
    supabase.auth.getUser().then(({ data }) => { if (ativo) setEmail((data?.user?.email || "").toLowerCase()); });
    return () => { ativo = false; };
  }, []);

  const GESTAO = ["amanda.seibel@aelbra.com.br", "cobranca07@aelbra.com.br", "cobranca04@aelbra.com.br"];
  const podeVer = {
    links: GESTAO.includes(email),
    termos: GESTAO.includes(email),
    confirmacao: GESTAO.includes(email),
    baixas: email === "amanda.seibel@aelbra.com.br",
  };
  const abas = [
    { chave: "links", rot: "Links", cont: c ? num(c.links_pendentes) : null },
    { chave: "baixas", rot: "Baixas", cont: c ? num(c.baixas_aguardando) : null },
    { chave: "confirmacao", rot: "Confirmação", cont: c ? num(c.confirmacao_aguardando) : null },
    { chave: "termos", rot: "Termos", cont: null },
  ].filter((a) => email === "" || podeVer[a.chave]);

  useEffect(() => {
    if (email && !podeVer[aba]) {
      const primeira = abas[0];
      if (primeira) setAba(primeira.chave);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>Central de pagamentos</h1>
        <span style={S.sub}>Links, baixas e confirmação num só lugar</span>
      </div>

      <div style={S.cards}>
        <Card rot="Links pendentes" val={c ? num(c.links_pendentes) : "-"} cor="#1d4ed8" />
        <Card rot="Links pagos" val={c ? num(c.links_pagos) : "-"} cor="#2563eb" />
        <Card rot="Aguardando confirmação" val={c ? num(c.confirmacao_aguardando) : "-"} cor="#b45309" />
        <Card rot="Fila de baixa" val={c ? num(c.baixas_aguardando) : "-"} cor="#2563eb" />
        <Card rot="Sem valor informado" val={c ? num(c.confirmacao_sem_valor) : "-"} cor="#dc2626" />
        <Card rot="Confirmados no mês" val={c ? num(c.confirmadas_mes) : "-"} cor="#2563eb" />
      </div>

      <div style={S.tabs}>
        {abas.map((t) => (
          <button
            key={t.chave}
            onClick={() => setAba(t.chave)}
            style={aba === t.chave ? S.tabOn : S.tab}
          >
            {t.rot}
            {t.cont != null ? <span style={aba === t.chave ? S.badgeOn : S.badge}>{t.cont}</span> : null}
          </button>
        ))}
      </div>

      <div style={S.conteudo}>
        {aba === "links" && <ControleLinksPagamento />}
        {aba === "baixas" && <FilaFinanceiro />}
        {aba === "confirmacao" && <FilaConfirmacaoPagamento />}
        {aba === "termos" && <FilaAdmTermos />}
      </div>
    </div>
  );
}

function Card({ rot, val, cor }) {
  return (
    <div style={S.card}>
      <span style={{ ...S.cardVal, color: cor }}>{val}</span>
      <span style={S.cardRot}>{rot}</span>
    </div>
  );
}

const S = {
  wrap: { padding: 20 },
  head: { marginBottom: 14 },
  h1: { margin: 0, fontSize: 22, color: "#0f172a" },
  sub: { fontSize: 13, color: "#64748b" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 },
  card: { background: "#f8fafc", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 },
  cardVal: { fontSize: 22, fontWeight: 800, lineHeight: 1.1 },
  cardRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  tabs: { display: "flex", gap: 6, borderBottom: "1px solid #e5e7eb", marginBottom: 14, flexWrap: "wrap" },
  tab: { background: "none", border: "none", padding: "9px 16px", fontSize: 14, color: "#64748b", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, borderBottom: "2px solid transparent" },
  tabOn: { background: "none", border: "none", padding: "9px 16px", fontSize: 14, color: "#1d4ed8", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, borderBottom: "2px solid #1d4ed8", fontWeight: 700 },
  badge: { background: "#f1f5f9", color: "#475569", borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 700 },
  badgeOn: { background: "#dbeafe", color: "#1d4ed8", borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 700 },
  conteudo: { borderTop: "1px solid #f1f5f9", paddingTop: 6 },
};
