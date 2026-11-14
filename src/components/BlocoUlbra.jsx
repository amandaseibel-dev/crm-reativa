import { useState, useEffect, useRef } from "react";
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

// Botao de CONSULTA (modo sob demanda). Mesma familia do destaque, com contorno:
// a acao custa uma consulta e precisa ser lida como acao.
const ESTILO_CONSULTA = {
  ...ESTILO.botaoDestaque,
  background: "#fff",
  color: "#1d4ed8",
  border: "1px solid #1d4ed8",
  cursor: "pointer",
};

// Unica rota desta tela que toca a Mensageria: `ulbra-consultar`.
async function chamarUlbraConsultar(alunoId) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("SEM_TOKEN");
  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ulbra-consultar`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ aluno_id: alunoId }),
    }
  );
  return resp.json();
}

// Resposta da funcao -> estado de tela. Falha de gravacao tem estado proprio.
function estadoDaResposta(json) {
  if (!json.status && MSG_FALHA_DE_GRAVACAO[json.erro]) return "falha_gravacao";
  return json.status ?? "erro";
}

// SOB DEMANDA (padrao, decisao da gestao em 11/11/2026): a ficha NAO consulta a
// Mensageria ao abrir. Primeiro le so o banco (`ulbra_vinculo_aluno`): vinculo
// confirmado por CPF vira o link CRM ULBRA ↗, sem gastar cota. So sem vinculo
// aparece "Consultar vínculo na ULBRA", e a consulta externa acontece por clique,
// uma vez. `sobDemanda={false}` mantem o comportamento antigo, so para testes.
export default function BlocoUlbra({ aluno, sobDemanda = true, rotuloConsulta = "Consultar Mensageria ULBRA" }) {
  const [estado, setEstado] = useState(sobDemanda ? "lendo" : "ocioso");
  const [dados, setDados] = useState(null);
  const [pedido, setPedido] = useState(null); // id do aluno para o qual a consulta externa foi pedida
  const emCurso = useRef(false);

  const consultaLiberada = !sobDemanda || pedido === aluno?.id;

  // Leitura do banco: nenhuma chamada a Mensageria.
  useEffect(() => {
    if (!aluno?.id || !sobDemanda || pedido === aluno.id) return;
    let cancelado = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("ulbra_vinculo_aluno", { p_aluno_id: aluno.id });
        if (cancelado) return;
        if (error || !data) { setEstado("sem_vinculo"); return; }
        if (data.status === "vinculado" && data.url) {
          setDados({ status: "vinculado", url: data.url });
          setEstado("vinculado");
          return;
        }
        if (data.status === "vinculado_nao_confirmado") { setEstado("vinculado_nao_confirmado"); return; }
        if (data.status === "sem_acesso") { setEstado("sem_acesso"); return; }
        setEstado("sem_vinculo");
      } catch {
        if (!cancelado) setEstado("sem_vinculo");
      }
    })();
    return () => { cancelado = true; };
  }, [aluno?.id, sobDemanda, pedido]);

  // Consulta externa: so depois do clique (sob demanda) ou sempre (sobDemanda=false).
  useEffect(() => {
    if (!aluno?.id || !consultaLiberada) return;
    let cancelado = false;
    (async () => {
      if (!cancelado) setEstado("carregando");
      try {
        const json = await chamarUlbraConsultar(aluno.id);
        if (cancelado) return;
        setDados(json);
        setEstado(estadoDaResposta(json));
      } catch {
        if (!cancelado) setEstado("erro");
      } finally {
        emCurso.current = false;
      }
    })();
    return () => { cancelado = true; };
  }, [aluno?.id, consultaLiberada]);

  // Clique: uma consulta por vez; cliques repetidos nao disparam outra.
  const pedirConsulta = () => {
    if (emCurso.current || !aluno?.id) return;
    emCurso.current = true;
    setPedido(aluno.id);
  };

  if (!aluno?.id) return null;

  if (sobDemanda && !consultaLiberada) {
    if (estado === "lendo") return <div style={ESTILO.neutro}>Verificando vínculo…</div>;
    if (estado === "sem_acesso") return null;
    if (estado === "vinculado_nao_confirmado") {
      return (
        <div style={ESTILO.aviso}>
          Vínculo sem confirmação por CPF — a gestão precisa conferir a identidade
          antes de abrir na Mensageria
        </div>
      );
    }
    if (estado !== "vinculado" || !dados?.url) {
      return (
        <div style={ESTILO.caixaLink}>
          <button
            type="button"
            style={ESTILO_CONSULTA}
            onClick={pedirConsulta}
            data-testid="ulbra-consultar"
            title="Consulta a Mensageria ULBRA para este aluno (1 consulta da cota diária)"
          >
            {rotuloConsulta}
          </button>
          <div style={ESTILO.neutro}>Consome 1 consulta na Mensageria ULBRA.</div>
        </div>
      );
    }
  }

  if (sobDemanda && consultaLiberada && estado === "erro") {
    return (
      <div style={ESTILO.caixaLink}>
        <div style={ESTILO.erro}>Não foi possível consultar agora.</div>
        <button type="button" style={ESTILO_CONSULTA} onClick={() => { emCurso.current = false; setPedido(null); }}>
          Tentar de novo
        </button>
      </div>
    );
  }

  if (estado === "erro") return null;

  if (estado === "carregando") {
    return <div style={ESTILO.neutro}>Consultando Mensageria Ulbra…</div>;
  }

  if (estado === "vinculado_nao_confirmado") {
    return (
      <div style={ESTILO.aviso}>
        Vínculo sem confirmação por CPF — a gestão precisa conferir a identidade
        antes de abrir na Mensageria
      </div>
    );
  }

  if (estado === "vinculado" && dados?.url) {
    // Vínculo não confirmado por CPF nunca tem link, mesmo se a resposta trouxer `url`.
    if (dados.reconfirmar_recomendado) {
      return (
        <div style={ESTILO.aviso}>
          Vínculo sem confirmação por CPF — a gestão precisa conferir a
          identidade antes de abrir na Mensageria
        </div>
      );
    }

    // Mesmo <a>, mesmo href, mesmo target e rel. Rotulo unico em todas as fichas.
    return (
      <div style={ESTILO.caixaLink}>
        <a
          href={dados.url}
          target="_blank"
          rel="noopener noreferrer"
          style={ESTILO.botaoDestaque}
        >
          <IconeConversa />
          CRM ULBRA ↗
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
