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

// Botao secundario, nos mesmos tokens do cartao de contatos da ficha (onde
// este bloco e renderizado): contorno azul sobre a superficie, nunca azul
// cheio -- o preenchido e reservado para a acao principal da tela.
const ESTILO = {
  caixaLink: { marginTop: 6 },
  botaoSecundario: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: "var(--rv-superficie)",
    color: "var(--rv-azul-texto)",
    border: "1px solid var(--rv-azul-borda)",
    borderRadius: 8,
    padding: "6px 11px",
    fontSize: 12,
    fontWeight: 700,
    textDecoration: "none",
    cursor: "pointer",
  },
  // Os avisos usavam classes do Tailwind (`text-xs text-amber-600`), e este
  // projeto NAO tem Tailwind: sem config, sem dependencia, sem `@tailwind` no
  // index.css. Na pratica as classes nunca pintaram nada e todo aviso saia em
  // texto preto de tamanho normal -- justamente os que precisam ser lidos como
  // alerta. Agora vao nos tokens claros da ficha, sem tocar em CSS global.
  aviso: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 1.4,
    fontWeight: 600,
    color: "var(--rv-ambar-texto)",
  },
  erro: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 1.4,
    fontWeight: 700,
    color: "var(--rv-vermelho-texto)",
  },
  neutro: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 1.4,
    color: "var(--rv-texto-fraco)",
  },
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
    return <div style={ESTILO.neutro}>Consultando Mensageria Ulbra…</div>;
  }

  // Vínculo que existe mas NÃO foi confirmado por CPF: aviso, nunca botão.
  // A função já devolve este caso sem `url` e sem `ulbra_cliente_id`; esta tela
  // não reconstrói a URL nem oferece caminho para abrir o atendimento.
  if (estado === "vinculado_nao_confirmado") {
    return (
      <div style={ESTILO.aviso}>
        Vínculo sem confirmação por CPF — a gestão precisa conferir a identidade
        antes de abrir na Mensageria
      </div>
    );
  }

  if (estado === "vinculado" && dados?.url) {
    // Cinto e suspensório: se uma versão anterior da função devolver `url`
    // JUNTO com `reconfirmar_recomendado`, a tela ainda assim não dá o botão.
    // Vínculo não confirmado por CPF não tem acesso automático — o aviso
    // sozinho não segura ninguém, porque o botão ao lado continua clicável.
    if (dados.reconfirmar_recomendado) {
      return (
        <div style={ESTILO.aviso}>
          Vínculo sem confirmação por CPF — a gestão precisa conferir a
          identidade antes de abrir na Mensageria
        </div>
      );
    }

    // SO o visual mudou aqui (rotulo curto e aparencia de botao secundario,
    // para ficar junto dos contatos na ficha). Segue sendo um <a> de verdade,
    // com o MESMO `href` vindo da funcao, o MESMO `target="_blank"` e o MESMO
    // `rel="noopener noreferrer"` -- a aba nova nao ganha acesso a esta.
    // A escada de condicao acima nao foi tocada.
    return (
      <div style={ESTILO.caixaLink}>
        <a
          href={dados.url}
          target="_blank"
          rel="noopener noreferrer"
          style={ESTILO.botaoSecundario}
        >
          Mensageria ULBRA ↗
        </a>
      </div>
    );
  }

  if (estado === "falha_gravacao") {
    return (
      <div style={ESTILO.erro}>
        {MSG_FALHA_DE_GRAVACAO[dados?.erro]}
      </div>
    );
  }

  if (estado === "bloqueado") {
    return (
      <div style={ESTILO.aviso}>
        {MSG_BLOQUEIO[dados?.motivo] ?? "Vínculo com a Mensageria não confirmado"}
      </div>
    );
  }

  if (estado === "nao_encontrado" && dados?.motivo) {
    return (
      <div style={ESTILO.neutro}>
        {MSG_NAO_ENCONTRADO[dados.motivo] ?? "Não encontrado na Mensageria Ulbra"}
      </div>
    );
  }

  return null;
}
