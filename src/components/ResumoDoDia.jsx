import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function inicioDoDiaISO() {
  const agora = new Date();
  agora.setHours(0, 0, 0, 0);
  return agora.toISOString();
}

function fimDoDiaISO() {
  const agora = new Date();
  agora.setHours(23, 59, 59, 999);
  return agora.toISOString();
}

const CARTOES = [
  { chave: "acordosFechados", label: "Acordos fechados", icone: "🤝" },
  { chave: "linksEnviados", label: "Links enviados", icone: "🔗" },
  { chave: "mensagensEnviadas", label: "Mensagens enviadas", icone: "💬" },
  { chave: "semRetorno", label: "Sem retorno", icone: "🔇" },
  { chave: "naoLocalizado", label: "Não localizado", icone: "🔍" },
  { chave: "totalFinalizados", label: "Total tabulado", icone: "✅" },
];

export default function ResumoDoDia({ usuarioLogado }) {
  const [contagens, setContagens] = useState(null);

  useEffect(() => {
    if (!usuarioLogado?.email) return;

    async function carregar() {
      const { data } = await supabase
        .from("aluno_movimentacoes")
        .select("tipo, status_novo")
        .eq("registrado_por_email", usuarioLogado.email)
        .gte("registrado_em", inicioDoDiaISO())
        .lte("registrado_em", fimDoDiaISO());

      const linhas = data || [];

      const totalFinalizados = linhas.filter(
        (l) => l.tipo === "FINALIZACAO_ATENDIMENTO"
      ).length;

      const contar = (statusNovo) =>
        linhas.filter(
          (l) => l.tipo === "FINALIZACAO_ATENDIMENTO" && l.status_novo === statusNovo
        ).length;

      setContagens({
        acordosFechados: contar("ACORDO_FECHADO"),
        mensagensEnviadas: contar("MENSAGEM_ENVIADA"),
        semRetorno: contar("SEM_RETORNO"),
        naoLocalizado: contar("NAO_LOCALIZADO"),
        linksEnviados: linhas.filter((l) => l.tipo === "LINK_ENVIADO_AO_ALUNO").length,
        totalFinalizados,
      });
    }

    carregar();
    const intervalo = setInterval(carregar, 30000);
    return () => clearInterval(intervalo);
  }, [usuarioLogado?.email]);

  if (!contagens) return null;

  return (
    <div style={estilos.caixa}>
      <strong style={estilos.titulo}>📋 Seu resumo de hoje</strong>
      <div style={estilos.grade}>
        {CARTOES.map((cartao) => (
          <div key={cartao.chave} style={estilos.cartao}>
            <div style={estilos.numero}>{contagens[cartao.chave]}</div>
            <div style={estilos.label}>
              {cartao.icone} {cartao.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const estilos = {
  caixa: {
    padding: "12px 16px",
    marginBottom: 14,
    borderRadius: 10,
    background: "rgba(59, 130, 246, 0.06)",
    border: "1px solid rgba(59, 130, 246, 0.25)",
  },
  titulo: {
    fontSize: 14,
    display: "block",
    marginBottom: 10,
  },
  grade: {
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
  },
  cartao: {
    minWidth: 110,
    padding: "8px 12px",
    borderRadius: 8,
    background: "rgba(148, 163, 184, 0.08)",
    textAlign: "center",
  },
  numero: {
    fontSize: 20,
    fontWeight: 800,
  },
  label: {
    fontSize: 11,
    opacity: 0.75,
    marginTop: 2,
  },
};
