import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const SITUACAO = {
  new: "Novo",
  offered: "Oferecido",
  assigned: "Atribuído",
  accepted: "Em atendimento",
  waiting: "Aguardando resposta",
  done: "Concluído",
  expired: "Expirado",
};

function formatarData(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// Atendimento atual do aluno na Mensageria Ulbra. Uma consulta por abertura
// da ficha, só para aluno já vinculado; qualquer falha some em silêncio —
// a ficha nunca depende disto. O botão de abrir a Mensageria é do BlocoUlbra.
export default function AtendimentoUlbra({ aluno }) {
  const [dados, setDados] = useState(null);

  useEffect(() => {
    if (!aluno?.id) return;
    let cancelado = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ulbra-atendimento`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ aluno_id: aluno.id }),
          }
        );
        if (cancelado || !resp.ok) return;
        const json = await resp.json();
        if (!cancelado) setDados(json);
      } catch {
        // silencioso: integração não bloqueia a ficha
      }
    })();
    return () => { cancelado = true; };
  }, [aluno?.id]);

  if (!dados) return null;

  if (dados.status === "sem_atendimento") {
    return <div className="mt-1 text-xs text-gray-400">Sem atendimento na Mensageria Ulbra</div>;
  }
  if (dados.status !== "encontrado" || !dados.atendimento) return null;

  const a = dados.atendimento;
  return (
    <div className="mt-2 text-xs text-gray-700 border-l-2 border-blue-300 pl-2" data-testid="atendimento-ulbra">
      <div className="font-semibold text-gray-600">Atendimento na Mensageria Ulbra</div>
      <div>Situação: <strong>{SITUACAO[a.situacao] ?? a.situacao ?? "—"}</strong>{a.coluna ? ` · ${a.coluna}` : ""}</div>
      <div>Equipe: {a.equipe ?? "—"}</div>
      <div>Responsável: {a.atendente ?? "sem responsável"}</div>
      <div>Atualizado em: {formatarData(a.atualizado_em)}</div>
    </div>
  );
}
