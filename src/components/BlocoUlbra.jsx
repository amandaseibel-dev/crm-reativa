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

// Botao de DESTAQUE, por decisao da gestao em 08/11/2026. Era um contorno azul
// no RODAPE do cartao de contatos e passava batido: agora e azul cheio, texto
// branco, icone de conversa, e mora no TOPO do cartao, visivel sem rolagem.
// Isto revoga de proposito a regra anterior de "preenchido so para a acao
// principal da tela" -- a Mensageria e o canal que o operador mais usa.
//
// O azul vem cravado (`#1d4ed8`), e nao de `var(--rv-azul)`, pelo mesmo motivo
// dos outros botoes cheios do cartao (`Adicionar telefone`, `Salvar
// responsaveis`): no tema escuro `--rv-azul` vira #60a5fa e texto branco em
// cima dele perde contraste.
//
// `maxWidth: "100%"` existe para a tela estreita: com o `flexWrap` do cabecalho
// do cartao, o botao desce para a propria linha ACIMA dos telefones, sem
// sobrepor nenhum numero nem estourar a borda do cartao.
const ESTILO = {
  caixaLink: { display: "flex", minWidth: 0 },
  botaoDestaque: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    background: "#1d4ed8",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 12.5,
    fontWeight: 700,
    lineHeight: 1.25,
    textDecoration: "none",
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.18)",
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

// Icone de conversa em SVG inline: sem dependencia nova e herda a cor do texto
// do botao. `aria-hidden` porque o rotulo ao lado ja diz o que o botao faz.
function IconeConversa() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
    </svg>
  );
}

// SOB DEMANDA (decisão da gestão em 11/11/2026): a ficha NÃO consulta a
// Mensageria ao abrir. Cada consulta custa 1 chamada da cota diária da
// credencial (500/dia, compartilhada com a coleta): em 09/11 as fichas gastaram
// ~250. O operador clica quando precisa; `sobDemanda={false}` mantém o
// comportamento antigo só para testes.
export default function BlocoUlbra({ aluno, sobDemanda = true }) {
  const [estado, setEstado] = useState("ocioso");
  const [dados, setDados] = useState(null);
  const [pedido, setPedido] = useState(null); // id do aluno para o qual a consulta foi pedida

  const consultaLiberada = !sobDemanda || pedido === aluno?.id;

  useEffect(() => {
    if (!aluno?.id || !consultaLiberada) return;

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
  }, [aluno?.id, consultaLiberada]);

  if (!aluno?.id) return null;

  if (!consultaLiberada) {
    return (
      <div style={ESTILO.caixaLink}>
        <button
          type="button"
          style={ESTILO.botaoDestaque}
          onClick={() => setPedido(aluno.id)}
          data-testid="ulbra-consultar"
          title="Consulta a Mensageria ULBRA para este aluno (1 chamada da cota diária)"
        >
          <IconeConversa />
          Consultar Mensageria ULBRA
        </button>
      </div>
    );
  }

  if (estado === "erro") return null;

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

    // SO o visual mudou aqui (azul cheio, icone de conversa e rotulo "Abrir
    // Mensageria ULBRA ↗"). Segue sendo um <a> de verdade, com o MESMO `href`
    // vindo da funcao, o MESMO `target="_blank"` e o MESMO
    // `rel="noopener noreferrer"` -- a aba nova nao ganha acesso a esta.
    // A escada de condicao acima nao foi tocada: o botao continua existindo so
    // com vinculo confirmado por CPF.
    return (
      <div style={ESTILO.caixaLink}>
        <a
          href={dados.url}
          target="_blank"
          rel="noopener noreferrer"
          style={ESTILO.botaoDestaque}
        >
          <IconeConversa />
          Abrir Mensageria ULBRA ↗
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
