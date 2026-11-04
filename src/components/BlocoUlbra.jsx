import { useState, useEffect } from "react";
import { supabase } from "../services/supabase";

// Motivos de BLOQUEIO devolvidos pela `ulbra-consultar` quando o vínculo
// automático foi barrado de propósito. Nenhum deles é erro: são a recusa de
// gravar vínculo sem prova de identidade. O operador precisa VER a recusa —
// cair em silêncio é o que faz a tela parecer "sem Mensageria" quando na
// verdade existe um candidato que ninguém confirmou.
const MSG_BLOQUEIO = {
  AMBIGUO_CHAVES_DISCORDANTES:
    "Telefone e CPF apontam clientes diferentes na Mensageria — vínculo não criado",
  DUPLICADO_CLIENTE_DE_OUTRO_ALUNO:
    "O cliente encontrado já está vinculado a outro aluno — vínculo não criado",
  CONFIRMACAO_MANUAL_SO_TELEFONE:
    "Encontrado só pelo telefone, sem confirmação por CPF — precisa conferência da gestão",
  CONFIRMACAO_MANUAL_SEM_CPF:
    "Aluno sem CPF cadastrado: não há como confirmar identidade — precisa conferência da gestão",
};

// Falhas NOSSAS, em que havia um vínculo a gravar e ele não foi gravado. Essas
// o operador precisa ver: silêncio aqui faz a ficha parecer "sem Mensageria"
// quando o que houve foi erro de escrita. É o caso de deploy da função feito
// ANTES da migration 20261104200000 — a função grava `alta_cpf`, que o CHECK
// de hoje rejeita, e todo vínculo novo falha fechado.
//
// Falha de TERCEIRO e transitória (ULBRA_INDISPONIVEL, ULBRA_LIMITE,
// CONFIG_AUSENTE, SEM_TOKEN, ACESSO_NEGADO) segue silenciosa de propósito:
// não é acionável na ficha e poluiria toda ficha quando a Mensageria cai.
const MSG_FALHA_DE_GRAVACAO = {
  VINCULO_NAO_GRAVADO: "Vínculo encontrado mas não gravado — avise a gestão",
  VINCULO_LEITURA_FALHOU: "Não foi possível ler o vínculo — avise a gestão",
  DECISAO_INESPERADA: "Vínculo não concluído — avise a gestão",
};

const MSG_NAO_ENCONTRADO = {
  SEM_TELEFONE: "Aluno sem telefone e sem CPF cadastrados",
  TELEFONE_MALFORMADO: "Telefone com formato inválido",
  FORA_DO_ESCOPO: "Aluno fora do escopo da Mensageria",
  NAO_ENCONTRADO: "Não encontrado na Mensageria Ulbra",
  ALUNO_NAO_ENCONTRADO: "Aluno não encontrado",
};

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
        // Resposta de erro não traz `status`. Falha de gravação ganha estado
        // próprio para não cair no silêncio de "erro".
        if (!json.status && MSG_FALHA_DE_GRAVACAO[json.erro]) {
          setEstado("falha_gravacao");
          return;
        }
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
        {/* Vínculo da Etapa 1 (selo "alta" sem confirmação de CPF) continua
            válido e clicável — não é apagado nem escondido —, mas o operador
            precisa saber que a identidade não foi provada por CPF. */}
        {dados.reconfirmar_recomendado && (
          <div className="mt-1 text-xs text-amber-600">
            Vínculo antigo, sem confirmação por CPF — confira a identidade antes de usar
          </div>
        )}
      </div>
    );
  }

  if (estado === "falha_gravacao") {
    return (
      <div className="mt-1 text-xs text-red-600">
        {MSG_FALHA_DE_GRAVACAO[dados?.erro]}
      </div>
    );
  }

  if (estado === "bloqueado") {
    return (
      <div className="mt-1 text-xs text-amber-600">
        {MSG_BLOQUEIO[dados?.motivo] ?? "Vínculo com a Mensageria não confirmado"}
      </div>
    );
  }

  if (estado === "nao_encontrado" && dados?.motivo) {
    return (
      <div className="mt-1 text-xs text-gray-400">
        {MSG_NAO_ENCONTRADO[dados.motivo] ?? "Não encontrado na Mensageria Ulbra"}
      </div>
    );
  }

  return null;
}
