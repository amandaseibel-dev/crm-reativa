import { useState, useEffect } from "react";
import { supabase } from "../services/supabase";

export default function BlocoUlbra({ aluno }) {
  const [estado, setEstado] = useState("ocioso");
  const [dados, setDados] = useState(null);

  useEffect(() => {
    if (!aluno?.id) return;

    let cancelado = false;

    const consultar = async () => {
      if (!cancelado) setEstado("carregando");
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) { setEstado("erro"); return; }

        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ulbra-consultar`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ aluno_id: aluno.id }),
          }
        );
        if (cancelado) return;
        const json = await resp.json();
        setDados(json);
        setEstado(json.status ?? "erro");
      } catch {
        if (!cancelado) setEstado("erro");
      }
    };

    consultar();
    return () => { cancelado = true; };
  }, [aluno?.id]);

  if (!aluno?.id || estado === "erro") return null;

  if (estado === "carregando") {
    return <div className="text-xs text-gray-400 mt-1">Consultando Mensageria Ulbra…</div>;
  }

  if (estado === "vinculado" && dados?.url) {
    return (
      <div className="mt-2">
        <a
          href={dados.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          Abrir na Mensageria Ulbra ↗
        </a>
      </div>
    );
  }

  if (estado === "ambiguo") {
    return (
      <div className="mt-2 text-xs text-yellow-700">
        Múltiplos cadastros na Mensageria —{" "}
        <a href="/gestao/ulbra" className="underline">revisar na gestão</a>
      </div>
    );
  }

  if (estado === "nao_encontrado" && dados?.motivo) {
    const msgs = {
      SEM_TELEFONE: "Aluno sem telefone cadastrado",
      TELEFONE_MALFORMADO: "Telefone com formato inválido",
      FORA_DO_ESCOPO: "Aluno fora do escopo da Mensageria",
      NAO_ENCONTRADO: "Não encontrado na Mensageria Ulbra",
    };
    return (
      <div className="mt-1 text-xs text-gray-400">
        {msgs[dados.motivo] ?? "Não encontrado na Mensageria Ulbra"}
      </div>
    );
  }

  return null;
}
