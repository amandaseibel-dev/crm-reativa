import { useState, useEffect } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

const STATUS_ERRO = {
  NOVA: { rotulo: "Reportado", bg: "var(--rv-roxo-fundo)", cor: "var(--rv-roxo-texto)" },
  EM_ANALISE: { rotulo: "Em análise", bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  EM_TRATATIVA: { rotulo: "Em tratativa", bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  AGUARDANDO_VALIDACAO: { rotulo: "Aguardando sua validação", bg: "var(--rv-azul-fundo)", cor: "var(--rv-azul-texto)" },
  REABERTO: { rotulo: "Reaberto", bg: "var(--rv-vermelho-fundo)", cor: "var(--rv-vermelho)" },
  FEITA: { rotulo: "Corrigido", bg: "var(--rv-verde-ok-fundo)", cor: "var(--rv-verde-ok-texto)" },
  DESCARTADA: { rotulo: "Descartado", bg: "var(--rv-fundo-suave)", cor: "var(--rv-texto-suave)" },
};

const SECOES = [
  { grupo: "Início", itens: [{ id: "inicio", label: "🏠 Visão Geral", keywords: "início home resumo começo portal" }] },
  {
    grupo: "Atendimento",
    itens: [
      { id: "rotina", label: "📌 Pontos do Dia a Dia", keywords: "registro crm proposta objeção contato prioridade acordo cobrança regras rotina" },
      { id: "duvidas", label: "❓ Dúvidas Frequentes", keywords: "taxa parcelamento processo template acordo mensalidade cartão boleto dúvida recorrente" },
      { id: "mensagens", label: "💬 Mensagens Prontas", keywords: "frase pronta texto whatsapp email resposta aluno copiar mensagem" },
      { id: "objecoes", label: "🔥 Quebras de Objeção", keywords: "argumentação argumento não tenho dinheiro cartão pensar desconto objeção resposta" },
    ],
  },
  {
    grupo: "Negociação",
    itens: [
      { id: "politica", label: "📄 Política de Negociação", keywords: "à vista cartão boleto acordo parcelamento entrada condição negociação regra" },
      { id: "excecao", label: "📝 Proposta de Exceção", keywords: "proposta exceção desconto aprovação condição especial" },
      { id: "honorarios", label: "💰 Honorários e Taxas", keywords: "8% juros multa igpm taxa honorário encargos" },
      { id: "beneficios", label: "🎟️ Bolsas e Financiamentos", keywords: "bolsa fies prouni udebank educred quero bolsa credies financiamento" },
    ],
  },
  {
    grupo: "Vida Acadêmica",
    itens: [
      { id: "academico", label: "🎓 Matrícula e WebAluno", keywords: "matrícula rematrícula webaluno irpf contrato trancamento antecipação comprovante protocolo" },
      { id: "cursos", label: "📚 Cursos Ulbra", keywords: "curso graduação medicina ead presencial semipresencial faculdade" },
    ],
  },
  {
    grupo: "Operação",
    itens: [
      { id: "sistemas", label: "🚀 Sistemas e Planilhas", keywords: "reativa one crm mensageria gmail prime webaluno planilha sistema acesso" },
      { id: "links", label: "🔗 Links Úteis", keywords: "atalho acesso link site sistema planilha" },
      { id: "contatos", label: "☎️ Contatos Úteis", keywords: "telefone email ramal jurídico giovana bruno unidade adm financeiro contato" },
      { id: "meta", label: "🎯 Meta do Mês", keywords: "meta comissão honorário projeção resultado mês" },
      { id: "indicadores", label: "📊 Indicadores", keywords: "indicador contato acordo link termo baixa resultado" },
      { id: "sugestoes", label: "💡 Sugestões e Erros", keywords: "erro melhoria ideia ajuste sistema portal reportar problema" },
    ],
  },
  {
    grupo: "Segurança",
    itens: [{ id: "lgpd", label: "🔐 LGPD e Conduta", keywords: "cpf dados terceiro segurança privacidade conduta titular" }],
  },
  {
    grupo: "Equipe",
    itens: [
      { id: "cultura", label: "💚 Cultura Reativa", keywords: "equipe cultura valores reativa" },
      { id: "historia", label: "📸 Nossa História", keywords: "história equipe fotos reativa" },
    ],
  },
];



export default function PortalOperacional() {
  const [secao, setSecao] = useState("inicio");
  const [busca, setBusca] = useState("");

  const termoBusca = busca
    .trim()
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const secoesFiltradas = !termoBusca
    ? SECOES
    : SECOES.map((grupo) => ({
        ...grupo,
        itens: grupo.itens.filter((item) =>
          `${item.label} ${item.keywords || ""}`
            .toLocaleLowerCase("pt-BR")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .includes(termoBusca)
        ),
      })).filter((grupo) => grupo.itens.length);

  function navegar(id) {
    setSecao(id);
    setBusca("");
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  return (
    <div style={S.pagina}>
      <div style={S.shell}>
        <aside style={S.sidebar}>
          <div style={S.logoArea}>
            <div style={S.logoBox}>
              <span style={S.logoRe}>Re</span>
              <span style={S.logoAtiva}>ATIVA</span>
            </div>
            <div style={S.logoSub}>Portal Operacional</div>
          </div>

          <div style={S.buscaBox}>
            <span style={S.buscaIcone}>⌕</span>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar: acordo, bolsa, matrícula..."
              style={S.buscaInput}
              aria-label="Buscar seção no Portal"
            />
          </div>

          <nav style={S.nav}>
            {secoesFiltradas.length === 0 ? (
              <div style={S.semResultado}>Nenhuma seção encontrada.</div>
            ) : (
              secoesFiltradas.map((g) => (
                <div key={g.grupo} style={S.navGrupo}>
                  <div style={S.navGrupoLabel}>{g.grupo}</div>
                  {g.itens.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => navegar(it.id)}
                      style={{
                        ...S.navItem,
                        ...(secao === it.id ? S.navItemAtivo : {}),
                      }}
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              ))
            )}
          </nav>

          <div style={S.sidebarRodape}>
            <strong>Central oficial da operação</strong>
            <span>Consulta rápida • Regras • Apoio</span>
          </div>
        </aside>

        <main style={S.conteudo}>
          {secao === "inicio" && <SecaoInicio ir={navegar} />}
          {secao === "rotina" && <SecaoRotina />}
          {secao === "duvidas" && <SecaoDuvidas />}
          {secao === "mensagens" && <SecaoMensagens />}
          {secao === "objecoes" && <SecaoObjecoes />}
          {secao === "politica" && <SecaoPolitica />}
          {secao === "excecao" && <SecaoExcecao />}
          {secao === "honorarios" && <SecaoHonorarios />}
          {secao === "beneficios" && <SecaoBeneficios />}
          {secao === "academico" && <SecaoAcademico />}
          {secao === "cursos" && <SecaoCursos />}
          {secao === "sistemas" && <SecaoSistemas />}
          {secao === "links" && <SecaoLinks />}
          {secao === "contatos" && <SecaoContatos />}
          {secao === "meta" && <SecaoMeta />}
          {secao === "indicadores" && <SecaoIndicadores />}
          {secao === "sugestoes" && <SecaoSugestoes />}
          {secao === "lgpd" && <SecaoLgpd />}
          {secao === "cultura" && <SecaoCultura />}
          {secao === "historia" && <SecaoHistoria />}
        </main>
      </div>
    </div>
  );
}

/* ===================== Componentes visuais reutilizáveis ===================== */

function TituloSecao({ emoji, titulo, sub }) {
  return (
    <div style={S.tituloSecaoBox}>
      <h1 style={S.tituloSecaoH1}>
        {emoji} {titulo}
      </h1>
      {sub && <p style={S.tituloSecaoSub}>{sub}</p>}
    </div>
  );
}

function Card({ children, style }) {
  return <div style={{ ...S.card, ...style }}>{children}</div>;
}

function Aviso({ children, tom = "atencao" }) {
  return (
    <div style={{ ...S.aviso, ...(tom === "atencao" ? S.avisoAtencao : S.avisoInfo) }}>
      {children}
    </div>
  );
}

function BotaoPrimario({ children, href, onClick }) {
  const Comp = href ? "a" : "button";
  return (
    <Comp href={href} target={href ? "_blank" : undefined} rel="noreferrer" onClick={onClick} style={S.botaoPrimario}>
      {children}
    </Comp>
  );
}

function BotaoSecundario({ children, onClick, href }) {
  const Comp = href ? "a" : "button";
  return (
    <Comp href={href} onClick={onClick} style={S.botaoSecundario}>
      {children}
    </Comp>
  );
}

/* ===================== Início ===================== */

function SecaoInicio({ ir }) {
  const atalhos = [
    {
      emoji: "💳",
      titulo: "Preciso negociar",
      desc: "Consulte a política, formas de pagamento e regras para acordos.",
      id: "politica",
      acao: "Ver regras de negociação",
    },
    {
      emoji: "🔥",
      titulo: "O aluno apresentou uma objeção",
      desc: "Encontre argumentos e respostas para as situações mais recorrentes.",
      id: "objecoes",
      acao: "Abrir quebras de objeção",
    },
    {
      emoji: "💬",
      titulo: "Quero uma resposta pronta",
      desc: "Use modelos para WhatsApp e orientações que podem ser copiadas.",
      id: "mensagens",
      acao: "Ver mensagens prontas",
    },
    {
      emoji: "❓",
      titulo: "Tenho uma dúvida durante o atendimento",
      desc: "Consulte respostas rápidas antes de encaminhar o caso.",
      id: "duvidas",
      acao: "Consultar dúvidas",
    },
    {
      emoji: "🎓",
      titulo: "É assunto de matrícula ou WebAluno",
      desc: "Veja trancamento, documentos, rematrícula, antecipação e comprovantes.",
      id: "academico",
      acao: "Abrir vida acadêmica",
    },
    {
      emoji: "☎️",
      titulo: "Preciso encaminhar ou falar com alguém",
      desc: "Encontre ADM, Financeiro, Jurídico, unidades, telefones e e-mails.",
      id: "contatos",
      acao: "Abrir contatos",
    },
  ];

  return (
    <>
      <div style={S.hero}>
        <div style={S.heroConteudo}>
          <span style={S.heroEyebrow}>CENTRAL OPERACIONAL REATIVA</span>
          <h1 style={S.heroTitulo}>Encontre a orientação certa sem perder tempo.</h1>
          <p style={S.heroTexto}>
            Use o Portal durante o atendimento para consultar regras, mensagens, objeções,
            contatos, sistemas e orientações acadêmicas em poucos cliques.
          </p>
          <div style={S.heroAcoes}>
            <BotaoPrimario onClick={() => ir("rotina")}>📌 Regras do dia a dia</BotaoPrimario>
            <BotaoSecundario onClick={() => ir("politica")}>📄 Política de negociação</BotaoSecundario>
            <BotaoSecundario onClick={() => ir("contatos")}>☎️ Contatos úteis</BotaoSecundario>
          </div>
        </div>
      </div>

      <div style={S.statusGrid}>
        <Card style={{ ...S.statusCard, ...S.statusCardDestaque }}>
          <span style={S.statusRotulo}>Competência em cobrança</span>
          <strong style={S.statusValor}>2026/2 • até agosto/2026</strong>
          <span style={S.statusDescricao}>Mensalidades atualmente elegíveis na base de 2026/2.</span>
        </Card>
        <Card style={S.statusCard}>
          <span style={S.statusRotulo}>Prioridade de negociação</span>
          <strong style={S.statusValorMenor}>Acordos primeiro</strong>
          <span style={S.statusDescricao}>Sempre trate acordos antes das mensalidades.</span>
        </Card>
        <Card style={S.statusCard}>
          <span style={S.statusRotulo}>Regra de ouro</span>
          <strong style={S.statusValorMenor}>Registre tudo no CRM</strong>
          <span style={S.statusDescricao}>Proposta, objeção, retorno, encaminhamento e informação relevante.</span>
        </Card>
      </div>

      <Aviso>
        <strong>Antes de qualquer acionamento:</strong> consulte o CRM, confirme histórico, restrições,
        jurídico, cancelamento e dados de contato. Se a informação puder impactar o próximo atendimento,
        ela precisa estar registrada.
      </Aviso>

      <div style={S.blocoCabecalho}>
        <div>
          <span style={S.secaoEyebrow}>O QUE VOCÊ PRECISA FAZER?</span>
          <h2 style={S.h2}>Escolha a situação do atendimento</h2>
          <p style={S.blocoDescricao}>Os atalhos abaixo levam direto ao conteúdo mais provável para cada situação.</p>
        </div>
        <button type="button" onClick={() => (window.location.href = "/painel-carteira")} style={S.linkAcao}>
          Abrir Minha Carteira →
        </button>
      </div>

      <div style={S.grade3}>
        {atalhos.map((item) => (
          <CardAtalho
            key={item.id}
            emoji={item.emoji}
            titulo={item.titulo}
            desc={item.desc}
            acao={item.acao}
            onClick={() => ir(item.id)}
          />
        ))}
      </div>

      <div style={S.homeDuasColunas}>
        <Card>
          <span style={S.secaoEyebrow}>ANTES DE FINALIZAR</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Checklist rápido do atendimento</h3>
          <ul style={S.listaChecklist}>
            <li>Confirmei a identidade do aluno.</li>
            <li>Conferi histórico e restrições no CRM.</li>
            <li>Registrei proposta, objeção e retorno.</li>
            <li>Confirmei telefone e outros canais disponíveis.</li>
            <li>Direcionei assuntos de outras áreas ao setor correto.</li>
          </ul>
        </Card>

        <Card>
          <span style={S.secaoEyebrow}>MAIS CONSULTADOS</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Atalhos que vale deixar à mão</h3>
          <div style={S.listaAtalhosInternos}>
            <button type="button" onClick={() => ir("politica")} style={S.atalhoInterno}>Política de Negociação <span>→</span></button>
            <button type="button" onClick={() => ir("objecoes")} style={S.atalhoInterno}>Quebras de Objeção <span>→</span></button>
            <button type="button" onClick={() => ir("mensagens")} style={S.atalhoInterno}>Mensagens Prontas <span>→</span></button>
            <button type="button" onClick={() => ir("contatos")} style={S.atalhoInterno}>Contatos Úteis <span>→</span></button>
          </div>
        </Card>
      </div>
    </>
  );
}

function CardAtalho({ emoji, titulo, desc, acao, onClick }) {
  return (
    <button type="button" onClick={onClick} style={S.cardAtalho}>
      <span style={S.cardAtalhoEmoji}>{emoji}</span>
      <strong style={S.cardAtalhoTitulo}>{titulo}</strong>
      <span style={S.cardAtalhoDesc}>{desc}</span>
      <span style={S.cardAtalhoAcao}>{acao || "Abrir"} →</span>
    </button>
  );
}

/* ===================== Política ===================== */

function SecaoPolitica() {
  return (
    <>
      <TituloSecao emoji="📄" titulo="Política Operacional" sub="Resumo das principais regras de cobrança e negociação para consulta rápida da equipe." />
      <Card>
        <h3 style={S.h3}>Regras gerais</h3>
        <ul style={S.lista}>
          <li>Cobrança após 31 dias de atraso.</li>
          <li>Confirmar os 3 dígitos do CPF antes da tratativa.</li>
          <li>Não realizar simulações sem autorização.</li>
          <li>Não utilizar número pessoal para contato.</li>
          <li>Não fazer "tratativa sobre tratativa".</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>Acordos e pagamentos</h3>
        <ul style={S.lista}>
          <li>Priorizar pagamento à vista ou cartão.</li>
          <li>Acordos quebrados: somente à vista/cartão, salvo exceção aprovada.</li>
          <li>Termo obrigatório quando aplicável.</li>
          <li>Não incluir matrícula quando houver regra de bloqueio vigente.</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>💳 Tabela de Negociação — Rematrícula 2026/2</h3>
        <p style={S.observacao}>Condições para acordo novo de mensalidades. Parcela mínima de R$ 100,00. <strong>Vigente até 28/08/2026.</strong></p>
        <h4 style={{ fontSize: 14, fontWeight: 700, color: "var(--rv-tinta)", margin: "16px 0 6px" }}>Até 2022 <span style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)", background: "var(--rv-azul-fundo)", borderRadius: 999, padding: "2px 8px", marginLeft: 8 }}>sem juros</span></h4>
        <table style={S.tabela}>
          <thead><tr><th style={S.th}>Parc.</th><th style={S.th}>Desconto</th><th style={S.th}>Boleto</th><th style={S.th}>Cartão</th></tr></thead>
          <tbody>
          <tr><td style={S.td}>À vista</td><td style={S.td}>100% encargos + 50% principal</td><td style={S.td}>À vista</td><td style={S.td}>À vista</td></tr>
          <tr><td style={S.td}>6x</td><td style={S.td}>100% encargos + 40% principal</td><td style={S.td}>Parcelas iguais</td><td style={S.td}>Parcelas iguais</td></tr>
          <tr><td style={S.td}>12x</td><td style={S.td}>100% encargos + 30% principal</td><td style={S.td}>Parcelas iguais</td><td style={S.td}>Parcelas iguais</td></tr>
          <tr><td style={S.td}>18x</td><td style={S.td}>100% encargos</td><td style={S.td}>Parcelas iguais</td><td style={S.td}>Não se aplica</td></tr>
          </tbody>
        </table>
        <h4 style={{ fontSize: 14, fontWeight: 700, color: "var(--rv-tinta)", margin: "16px 0 6px" }}>2023 a 2024 <span style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)", background: "var(--rv-azul-fundo)", borderRadius: 999, padding: "2px 8px", marginLeft: 8 }}>juros 1% a.m.</span></h4>
        <table style={S.tabela}>
          <thead><tr><th style={S.th}>Parc.</th><th style={S.th}>Desconto</th><th style={S.th}>Boleto</th><th style={S.th}>Cartão</th></tr></thead>
          <tbody>
          <tr><td style={S.td}>À vista</td><td style={S.td}>80% encargos</td><td style={S.td}>À vista</td><td style={S.td}>À vista</td></tr>
          <tr><td style={S.td}>6x</td><td style={S.td}>50% encargos</td><td style={S.td}>Entrada 10% + 5x</td><td style={S.td}>Parcelas iguais</td></tr>
          <tr><td style={S.td}>12x</td><td style={S.td}>30% encargos</td><td style={S.td}>Entrada 15% + 11x</td><td style={S.td}>Parcelas iguais</td></tr>
          </tbody>
        </table>
        <h4 style={{ fontSize: 14, fontWeight: 700, color: "var(--rv-tinta)", margin: "16px 0 6px" }}>2025 <span style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)", background: "var(--rv-azul-fundo)", borderRadius: 999, padding: "2px 8px", marginLeft: 8 }}>juros 1% a.m.</span></h4>
        <table style={S.tabela}>
          <thead><tr><th style={S.th}>Parc.</th><th style={S.th}>Desconto</th><th style={S.th}>Boleto</th><th style={S.th}>Cartão</th></tr></thead>
          <tbody>
          <tr><td style={S.td}>À vista</td><td style={S.td}>50% encargos</td><td style={S.td}>À vista</td><td style={S.td}>À vista</td></tr>
          <tr><td style={S.td}>6x</td><td style={S.td}>—</td><td style={S.td}>Entrada 20% + 5x</td><td style={S.td}>Até 12x (entrada 10% + 11x)</td></tr>
          <tr><td style={S.td}>10x</td><td style={S.td}>—</td><td style={S.td}>Entrada 20% + 9x</td><td style={S.td}>Até 12x (entrada 10% + 11x)</td></tr>
          </tbody>
        </table>
        <h4 style={{ fontSize: 14, fontWeight: 700, color: "var(--rv-tinta)", margin: "16px 0 6px" }}>2026/1 <span style={{ fontSize: 11, fontWeight: 700, color: "var(--rv-azul-texto)", background: "var(--rv-azul-fundo)", borderRadius: 999, padding: "2px 8px", marginLeft: 8 }}>juros 1% a.m.</span></h4>
        <table style={S.tabela}>
          <thead><tr><th style={S.th}>Parc.</th><th style={S.th}>Desconto</th><th style={S.th}>Boleto</th><th style={S.th}>Cartão</th></tr></thead>
          <tbody>
          <tr><td style={S.td}>À vista</td><td style={S.td}>Sem desconto</td><td style={S.td}>À vista</td><td style={S.td}>À vista</td></tr>
          <tr><td style={S.td}>7x</td><td style={S.td}>Sem desconto</td><td style={S.td}>Entrada 30% + 6x</td><td style={S.td}>Até 10x (entrada 10% + 9x)</td></tr>
          </tbody>
        </table>
      </Card>
      <Card>
        <h3 style={S.h3}>Quitação de acordos/parcelamentos pendentes</h3>
        <ul style={S.lista}>
          <li><strong>À vista:</strong> valor corrigido/atualizado com juros e multa.</li>
          <li><strong>Parcelado:</strong> somente cartão de crédito, com entrada mínima de 10% à vista e o saldo em até 9 parcelas, encargos de 1%.</li>
        </ul>
      </Card>
      <Aviso>
        <strong>⚠️ Casos que não podem ser acionados.</strong> Se constar jurídico, cancelamento,
        restrição de contato ou qualquer bloqueio registrado no CRM, o aluno não deve ser acionado. Siga a
        orientação registrada no caso.
      </Aviso>
    </>
  );
}

/* ===================== Proposta de Exceção ===================== */

function SecaoExcecao() {
  return (
    <>
      <TituloSecao emoji="📝" titulo="Proposta de Exceção" sub="Orientações para solicitações que fogem da regra operacional vigente." />
      <Card>
        <h3 style={S.h3}>Quando utilizar</h3>
        <ul style={S.lista}>
          <li>Condição fora da política padrão.</li>
          <li>Entrada inferior à regra mínima.</li>
          <li>Prazo diferenciado ou situação com justificativa formal.</li>
          <li>Pedido que precisa de aprovação administrativa/supervisão.</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>O que deve conter</h3>
        <ul style={S.lista}>
          <li>Nome do aluno e CPF.</li>
          <li>Valor em aberto e condição proposta.</li>
          <li>Justificativa objetiva.</li>
          <li>Contexto relevante do caso.</li>
        </ul>
      </Card>
    </>
  );
}

/* ===================== Mensagens Prontas ===================== */

function BlocoCopiar({ titulo, texto }) {
  const [copiado, setCopiado] = useState(false);
  function copiar() {
    navigator.clipboard?.writeText(texto);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1800);
  }
  return (
    <Card>
      <h3 style={S.h3}>{titulo}</h3>
      <p style={S.paragrafo}>{texto}</p>
      <button type="button" onClick={copiar} style={S.botaoCopiar}>
        {copiado ? "✅ Copiado!" : "📋 Copiar"}
      </button>
    </Card>
  );
}

function SecaoMensagens() {
  return (
    <>
      <TituloSecao emoji="💬" titulo="Mensagens Prontas" sub="Modelos para apoiar a comunicação. Revise o caso no CRM antes de qualquer envio." />
      <Aviso>
        <strong>⚠️ Antes de enviar:</strong> confira histórico, jurídico, cancelamento e restrições de contato.
        <br /><strong>✍️ Escreva por completo</strong>, sem abreviações, e revise a ortografia.
        <br /><strong>🔐 Confirme a identificação</strong> antes de tratar dados financeiros.
      </Aviso>
      <Card>
        <h3 style={S.h3}>✍️ Assinatura Gov.br</h3>
        <ol style={S.listaOrdenada}>
          <li>Acesse o portal de assinatura do Gov.br.</li>
          <li>Faça login com seu CPF e senha.</li>
          <li>Selecione o documento em PDF.</li>
          <li>Escolha a posição da assinatura, se desejar.</li>
          <li>Assine e baixe o documento assinado.</li>
        </ol>
        <p style={S.observacao}>A conta Gov.br deve ser nível Prata ou Ouro.</p>
      </Card>
      <BlocoCopiar titulo="📌 Confirmação de acordo" texto="Olá! Para darmos andamento corretamente, pedimos que confirme o acordo conforme orientação enviada. A confirmação é necessária para seguirmos com agilidade no procedimento." />
      <BlocoCopiar titulo="📎 Envio de comprovante" texto="Olá! Após realizar o pagamento, por gentileza encaminhe o comprovante para que possamos registrar e seguir com a baixa conforme o procedimento." />
      <BlocoCopiar titulo="⏳ Aguardando comprovante" texto="Olá! Ainda estamos aguardando o envio do comprovante de pagamento para dar sequência à baixa. Assim que possível, encaminhe para concluirmos o procedimento." />
      <BlocoCopiar titulo="📄 Aguardando termo" texto="Olá! Precisamos que o termo de acordo seja assinado e devolvido para darmos continuidade. Qualquer dúvida na assinatura, estamos à disposição para ajudar." />
      <BlocoCopiar titulo="🔗 Link de pagamento enviado" texto="Olá! Encaminhamos o link de pagamento referente ao seu acordo. Qualquer dificuldade para acessar ou concluir o pagamento, é só nos avisar." />
      <BlocoCopiar titulo="✅ Acordo fechado" texto="Olá! Seu acordo foi registrado com sucesso. Fique atento às datas de vencimento das parcelas para manter tudo em dia." />
      <BlocoCopiar titulo="🔁 Retomando contato" texto="Olá! Estamos retomando o contato sobre a sua pendência. Vamos verificar a melhor forma de regularizar a situação." />
      <BlocoCopiar titulo="⚠️ Boleto vencendo em breve" texto="Olá! Passando para lembrar que o seu boleto vence em breve. Fique atento para evitar encargos e manter o acordo em dia." />
      <BlocoCopiar titulo="👋 Saudação / validação inicial" texto="Olá! Seja bem-vindo(a) à ReATIVA. Para darmos sequência ao seu atendimento, por gentileza, informe seu nome completo e os 3 primeiros dígitos do CPF. Ficamos no aguardo para prosseguir. Equipe ReATIVA." />
      <BlocoCopiar titulo="✅ Sem parcelas em aberto" texto="Verificamos em nosso sistema e, no momento, não há parcelas em aberto. Pedimos que desconsidere nosso contato. Tenha um ótimo dia!" />
      <BlocoCopiar titulo="💬 Falta de interação" texto="Olá! Como não tivemos retorno, este atendimento poderá ser encerrado. Quando desejar continuar, basta enviar uma nova mensagem para retomarmos." />
      <BlocoCopiar titulo="⏱️ Alta demanda" texto="Devido à alta demanda, nosso tempo de resposta pode estar maior do que o habitual. Agradecemos sua compreensão e estamos trabalhando para atendê-lo o mais breve possível." />
      <BlocoCopiar titulo="📅 Vencimento hoje" texto="Olá! Passando para lembrar que o vencimento do seu boleto é hoje. Para evitar encargos e manter o acordo em dia, orientamos que o pagamento seja realizado dentro do vencimento. Qualquer dúvida, estamos à disposição." />
      <BlocoCopiar titulo="💰 Solicitação de desconto" texto="Entendemos sua solicitação. As condições disponíveis seguem a política de negociação vigente. Vou verificar a melhor possibilidade disponível para o seu caso." />
      <BlocoCopiar
        titulo="💳 Acordo em aberto / sem condição de quitação"
        texto="Identificamos parcelas em aberto do seu acordo. Para regularização, as condições disponíveis são pagamento à vista ou no cartão de crédito, conforme a política vigente. Não realizamos novo parcelamento do acordo em boleto. Caso você não consiga quitar o saldo total agora, podemos seguir com o pagamento das parcelas individualmente, uma a uma. Importante: enquanto houver parcelas vencidas, a matrícula não será liberada."
      />
      <BlocoCopiar titulo="📝 Proposta de exceção em análise" texto="Olá! Recebemos sua solicitação e a proposta foi encaminhada para análise. Assim que houver retorno, informaremos se a condição foi aprovada. Caso aprovada, seguiremos com as próximas etapas necessárias para conclusão do acordo." />
      <BlocoCopiar
        titulo="🎓 Matrícula / rematrícula"
        texto="Você pode realizar sua matrícula diretamente pelo WebAluno, desde que não existam pendências impeditivas. Caso precise de atendimento ou auxílio no processo, posso encaminhar sua solicitação para o setor responsável pela rematrícula."
      />
      <BlocoCopiar
        titulo="📆 Antecipação de matrícula 2027/1"
        texto="A matrícula de 2027/1 já pode ser realizada antecipadamente. Ao efetivar a matrícula, as parcelas referentes ao próximo semestre podem começar a ser geradas antes do início das aulas. Por isso, é possível visualizar cobranças de 2027/1 ainda em 2026."
      />
    </>
  );
}

/* ===================== Objeções ===================== */

function SecaoObjecoes() {
  const itens = [
    {
      pergunta: "Vou pensar",
      principal: "Claro, sem problema. Só reforço que as condições atuais podem sofrer alteração posteriormente.",
      alternativa: "O que te faria se sentir mais seguro para conseguirmos concluir hoje?",
      objetivo: "Descobrir a objeção real.",
      atencao: "Não encurralar o aluno."
    },
    {
      pergunta: "Não tenho dinheiro",
      principal: "Entendo perfeitamente. Podemos verificar uma condição dentro das possibilidades disponíveis para facilitar sua regularização.",
      alternativa: "Posso verificar uma condição mais leve para tentarmos avançar sem comprometer seu orçamento.",
      objetivo: "Manter a negociação aberta com empatia.",
      atencao: "Evitar tom agressivo ou pressão excessiva."
    },
    {
      pergunta: "Não tenho cartão",
      principal: "Entendo. Para acordos, o parcelamento em boleto não é permitido. As condições são pagamento à vista ou cartão de crédito, conforme a política vigente.",
      alternativa: "Se você não conseguir quitar o saldo total agora, podemos verificar o pagamento das parcelas individualmente, uma a uma.",
      firme: "Enquanto houver parcelas vencidas do acordo, a matrícula não será liberada.",
      objetivo: "Apresentar a alternativa permitida sem criar uma condição fora da política.",
      atencao: "Não oferecer reparcelamento do acordo em boleto e não insistir no uso de cartão de terceiros."
    },
    {
      pergunta: "Me chama depois",
      principal: "Claro. Qual seria o melhor horário para eu retornar e conseguirmos verificar isso juntos com mais calma?",
      alternativa: "Posso deixar o retorno combinado para não perdermos o acompanhamento da negociação.",
      firme: "Quanto antes avaliarmos as condições disponíveis, mais rápido conseguimos definir uma solução.",
      objetivo: "Gerar compromisso de retorno.",
      atencao: "Evitar parecer insistente ou pressionar excessivamente."
    },
    {
      pergunta: "Já paguei",
      principal: "Perfeito, obrigado por informar. Pode me encaminhar o comprovante para validarmos e regularizarmos o quanto antes?",
      alternativa: "Assim conseguimos verificar internamente e evitar qualquer divergência.",
      objetivo: "Solicitar comprovante sem gerar confronto.",
      atencao: "Nunca afirmar erro do aluno ou do sistema antes da validação."
    },
    {
      pergunta: "Não reconheço esse valor",
      principal: "Posso te explicar a composição do débito para entendermos juntos de onde vêm os valores.",
      alternativa: "Consigo detalhar os valores e encargos registrados para você conferir.",
      objetivo: "Reduzir resistência e abrir espaço para negociação.",
      atencao: "Evitar tom defensivo ou discussão."
    },
    {
      pergunta: "Achei que estava trancado",
      principal: "Entendo. Posso verificar no sistema como ficou a situação acadêmica e te orientar da melhor forma.",
      alternativa: "Vamos conferir o registro antes de qualquer conclusão.",
      objetivo: "Evitar confronto e manter o aluno na conversa.",
      atencao: "Não confirmar cancelamento ou trancamento sem validação."
    },
    {
      pergunta: "Não estou estudando mais",
      principal: "Entendo. Mesmo sem vínculo ativo, valores anteriores podem permanecer em aberto. Vamos verificar sua situação.",
      alternativa: "Posso conferir os valores registrados e as condições disponíveis para regularização.",
      objetivo: "Separar vínculo acadêmico da pendência financeira.",
      atencao: "Evitar tom agressivo."
    },
    {
      pergunta: "Não sabia que tinha débito",
      principal: "Sem problema. Estou entrando em contato justamente para te atualizar sobre a situação e verificarmos juntos a melhor solução.",
      alternativa: "Posso te explicar os valores e também verificar as condições disponíveis.",
      objetivo: "Abrir diálogo sem gerar resistência.",
      atencao: "Evitar tom acusatório."
    },
    {
      pergunta: "Vou esperar a rematrícula",
      principal: "Entendo seu ponto. Ainda assim, podemos avaliar a regularização agora conforme as condições disponíveis.",
      alternativa: "Posso verificar as possibilidades atuais para você avaliar com calma.",
      objetivo: "Incentivar a análise da regularização sem prometer efeito acadêmico.",
      atencao: "Não vincular ou prometer rematrícula."
    },
    {
      pergunta: "Só vou pagar quando voltar a estudar",
      principal: "Entendo. Mesmo assim, podemos verificar a situação financeira atual e as possibilidades de regularização.",
      alternativa: "Posso te apresentar as condições disponíveis neste momento.",
      objetivo: "Antecipar a análise da pendência.",
      atencao: "Não prometer benefício acadêmico."
    },
    {
      pergunta: "Estou desempregado(a)",
      principal: "Entendo perfeitamente sua situação. Podemos verificar uma condição mais adequada dentro das possibilidades disponíveis.",
      alternativa: "O objetivo é buscarmos algo que fique viável para o seu momento atual.",
      objetivo: "Demonstrar empatia sem perder a negociação.",
      atencao: "Manter abordagem humanizada."
    },
    {
      pergunta: "Estou passando por problemas pessoais",
      principal: "Sinto muito pela situação. Podemos verificar juntos uma alternativa possível para tentar facilitar este momento.",
      alternativa: "O objetivo é buscarmos uma solução viável dentro das condições disponíveis.",
      objetivo: "Criar acolhimento e manter abertura para negociação.",
      atencao: "Evitar insistência excessiva."
    },
    {
      pergunta: "Vou falar com meus pais/esposo(a)",
      principal: "Perfeito. Qual seria o melhor horário para retornarmos depois que vocês alinharem?",
      alternativa: "Posso deixar um retorno programado para retomarmos a conversa.",
      objetivo: "Gerar compromisso de retorno.",
      atencao: "Evitar pressionar terceiros ou compartilhar dados com eles."
    },
    {
      pergunta: "Não consigo dar entrada",
      principal: "Entendo. Posso verificar se existe alguma condição alternativa dentro da política vigente.",
      alternativa: "Vamos conferir o que é possível antes de concluir que não há alternativa.",
      objetivo: "Manter a negociação ativa.",
      atencao: "Não prometer exceções sem aprovação."
    },
    {
      pergunta: "Só consigo parcelado",
      principal: "Vamos verificar primeiro se a pendência é de mensalidade ou de acordo, porque as condições são diferentes.",
      alternativa: "Se for acordo, não podemos reparcelar em boleto. A regularização é à vista ou no cartão; sem condição de quitação total, podemos oferecer o pagamento das parcelas individualmente.",
      objetivo: "Aplicar a condição correta conforme o tipo da dívida.",
      atencao: "Em acordos, não oferecer novo parcelamento em boleto. Havendo parcelas vencidas, sinalizar que a matrícula não será liberada."
    },
    {
      pergunta: "Não tenho limite",
      principal: "Entendo. Podemos avaliar outras formas de negociação disponíveis que não dependam desse limite.",
      alternativa: "Vamos verificar quais opções estão disponíveis para o seu caso.",
      objetivo: "Evitar encerramento precoce da negociação.",
      atencao: "Não insistir excessivamente no cartão."
    },
    {
      pergunta: "Tenho outras dívidas",
      principal: "Entendo. Podemos verificar uma condição que ajude a organizar esta pendência dentro da sua realidade.",
      alternativa: "O objetivo é encontrarmos uma alternativa viável sem desconsiderar seu momento financeiro.",
      objetivo: "Mostrar possibilidade de regularização sem julgamento.",
      atencao: "Evitar julgamento financeiro."
    },
    {
      pergunta: "Achei injusta a cobrança",
      principal: "Entendo sua percepção. Posso te explicar melhor a situação e verificarmos juntos os detalhes.",
      alternativa: "Vamos conferir a composição e os registros antes de avançarmos.",
      objetivo: "Reduzir confronto.",
      atencao: "Nunca discutir com o aluno."
    },
    {
      pergunta: "Não usei o curso / Não consegui acessar",
      principal: "Entendo. Posso verificar as informações registradas e te orientar sobre a situação do débito.",
      alternativa: "Vamos conferir o histórico antes de qualquer conclusão.",
      objetivo: "Evitar conflito inicial.",
      atencao: "Não invalidar o relato do aluno."
    },
    {
      pergunta: "Vou entrar na justiça",
      principal: "Você tem o direito de buscar orientação. Da nossa parte, podemos continuar esclarecendo as possibilidades administrativas disponíveis.",
      alternativa: "Se desejar, posso explicar as condições vigentes e registrar sua manifestação.",
      objetivo: "Desarmar conflito.",
      atencao: "Nunca confrontar, ameaçar ou fazer avaliação jurídica."
    },
    {
      pergunta: "Quero desconto maior",
      principal: "Entendo. No momento estou te apresentando as condições disponíveis para o seu caso.",
      alternativa: "Se houver justificativa, posso verificar se cabe encaminhamento de proposta de exceção.",
      objetivo: "Valorizar a proposta apresentada.",
      atencao: "Não criar expectativa de aprovação."
    },
    {
      pergunta: "Quero boleto",
      principal: "Posso verificar as opções disponíveis para formalização da negociação por boleto conforme a política vigente.",
      alternativa: "Vamos conferir se o boleto está disponível para este tipo de negociação.",
      objetivo: "Facilitar o avanço dentro da regra.",
      atencao: "Validar a política antes da formalização."
    },
    {
      pergunta: "Não confio em negociação por WhatsApp",
      principal: "Entendo. O atendimento deve ocorrer pelos canais oficiais da ReATIVA e podemos confirmar os dados e procedimentos por esses meios.",
      alternativa: "Se preferir, podemos utilizar outro canal oficial disponível para formalizar as informações.",
      objetivo: "Transmitir segurança e credibilidade.",
      atencao: "Sempre reforçar canais oficiais."
    },
    {
      pergunta: "Preciso do diploma/documento",
      principal: "Entendo. Podemos verificar sua situação financeira e orientar a regularização, mas a liberação de documentos depende da análise da área responsável.",
      alternativa: "Posso te orientar sobre a parte financeira e indicar o canal adequado para a questão documental.",
      objetivo: "Separar negociação financeira de procedimento acadêmico.",
      atencao: "Não prometer liberação automática de documentos."
    },
    {
      pergunta: "Quero liberar matrícula / Preciso voltar a estudar",
      principal: "Entendo. Podemos verificar as condições disponíveis para regularização da pendência financeira.",
      alternativa: "Depois da regularização, qualquer questão de matrícula deve ser confirmada com a área responsável.",
      objetivo: "Apoiar a regularização sem prometer resultado acadêmico.",
      atencao: "Não garantir matrícula ou rematrícula."
    },
    {
      pergunta: "Não consigo pagar esse valor mensal",
      principal: "Entendo. Podemos verificar uma composição prevista na política que fique mais adequada à sua realidade.",
      alternativa: "Vamos conferir as opções disponíveis antes de definirmos a melhor condição.",
      objetivo: "Adequar a negociação à capacidade informada.",
      atencao: "Respeitar os limites da política de negociação."
    },
    {
      pergunta: "Estou descontente com a universidade",
      principal: "Entendo sua insatisfação e respeito seu posicionamento. Meu objetivo aqui é ajudar na parte financeira sem desconsiderar o seu relato.",
      alternativa: "Podemos registrar sua observação e, separadamente, verificar as possibilidades de regularização da pendência.",
      firme: "A questão acadêmica pode seguir pelo canal responsável enquanto tratamos, se você desejar, das opções financeiras disponíveis.",
      objetivo: "Separar a insatisfação institucional da negociação financeira.",
      atencao: "Nunca discutir, minimizar a reclamação ou defender excessivamente a instituição."
    },
    {
      pergunta: "Perda do desconto de antecipação",
      principal: "Entendo a sua dúvida. Vamos conferir o contrato ou termo aplicável e a regra vigente para explicar corretamente a composição do valor após o vencimento.",
      alternativa: "Posso verificar o registro do seu caso e detalhar os encargos aplicados.",
      objetivo: "Esclarecer a cobrança com base na regra efetivamente aplicável.",
      atencao: "Não citar cláusula antiga nem afirmar que um valor é devido sem validar o contrato e a regra vigente."
    },
    {
      pergunta: "MEC / Cursos de Medicina",
      principal: "Entendo sua dúvida. Antes de responder sobre funcionamento, calendário ou orientação do MEC, precisamos conferir a comunicação institucional vigente para a unidade e o curso.",
      alternativa: "Posso verificar a orientação oficial mais recente e te direcionar corretamente.",
      objetivo: "Evitar repassar informação institucional desatualizada.",
      atencao: "Não afirmar situação de curso, calendário ou MEC sem orientação oficial atual."
    },
    {
      pergunta: "Não fui eu quem fez o acordo",
      principal: "Entendo a dúvida. Vou confirmar os dados cadastrais e o histórico antes de seguirmos.",
      alternativa: "Vamos validar o registro do acordo antes de qualquer conclusão.",
      objetivo: "Garantir que a tratativa esteja vinculada à pessoa e ao acordo corretos.",
      atencao: "Não atribuir responsabilidade antes da validação."
    },
    {
      pergunta: "Já fiz acordo antes e não deu certo",
      principal: "Entendo. Vamos revisar o cenário atual e verificar o que é possível dentro das regras vigentes.",
      alternativa: "Posso conferir o histórico do acordo anterior e as condições disponíveis agora.",
      objetivo: "Retomar a negociação com base no histórico real.",
      atencao: "Não prometer condição diferente sem previsão na política."
    },
    {
      pergunta: "Por que estou pagando 8% a mais?",
      principal: "Esse percentual corresponde aos honorários de cobrança previstos para débitos acima de 30 dias, conforme a regra vigente.",
      alternativa: "Posso detalhar a composição do valor para você conferir como os honorários aparecem no débito.",
      objetivo: "Explicar a composição de forma simples.",
      atencao: "Não chamar de taxa bancária, taxa da operadora ou taxa do estabelecimento."
    }
  ];

  return (
    <>
      <TituloSecao
        emoji="🔥"
        titulo="Quebras de Objeção"
        sub="Biblioteca de apoio para situações recorrentes de negociação. Adapte a resposta ao caso e respeite sempre a política vigente."
      />
      <Aviso>
        <strong>⚠️ Use como apoio, não como resposta automática.</strong> Antes de responder, confira o caso no CRM, a política vigente e qualquer orientação específica registrada.
      </Aviso>

      {itens.map((it) => (
        <Card key={it.pergunta}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 800, color: "var(--rv-tinta)", fontSize: 14 }}>
              ❌ {it.pergunta}
            </summary>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <div>
                <strong>✅ Resposta principal</strong>
                <p style={{ ...S.paragrafo, marginTop: 4 }}>{it.principal}</p>
              </div>
              {it.alternativa && (
                <div>
                  <strong>🟡 Alternativa</strong>
                  <p style={{ ...S.paragrafo, marginTop: 4 }}>{it.alternativa}</p>
                </div>
              )}
              {it.firme && (
                <div>
                  <strong>🔴 Resposta firme</strong>
                  <p style={{ ...S.paragrafo, marginTop: 4 }}>{it.firme}</p>
                </div>
              )}
              <div>
                <strong>🎯 Objetivo</strong>
                <p style={{ ...S.paragrafo, marginTop: 4 }}>{it.objetivo}</p>
              </div>
              <div>
                <strong>⚠️ Atenção</strong>
                <p style={{ ...S.paragrafo, marginTop: 4 }}>{it.atencao}</p>
              </div>
            </div>
          </details>
        </Card>
      ))}
    </>
  );
}

/* ===================== Dúvidas Frequentes ===================== */

function SecaoDuvidas() {
  const itens = [
    { p: "Posso acionar sem conferir o Prime?", r: "Não. A conferência no Prime é obrigatória antes de qualquer mensagem ou contato. Ainda estamos ajustando o CRM para que concentre 100% das informações necessárias; por isso, a validação no Prime continua sendo indispensável para evitar retrabalho, contatos indevidos e custos desnecessários de tempo e de acionamento." },
    { p: "Quando não posso acionar?", r: "Quando houver jurídico, cancelamento, bloqueio, restrição de contato ou orientação registrada impedindo acionamento." },
    { p: "Comprovante de cartão deve ir onde?", r: "O comprovante deve ser salvo e sinalizado conforme o procedimento operacional vigente." },
    { p: "E se o termo não funcionar?", r: "Encaminhe para a área responsável e sinalize no canal combinado para ajuste." },
    { p: "Por que existe 1% de parcelamento se no link aparece “sem taxa de parcelamento”?", r: "Nas negociações parceladas, o sistema aplica 1% de encargo de parcelamento por parcela, conforme a condição da negociação. Quando o link informa “sem taxa de parcelamento”, significa que o próprio link não acrescentará uma nova taxa sobre o valor já negociado. Não informar que esse percentual é taxa do banco, da operadora ou do estabelecimento." },
    { p: "Qual a prioridade de negociação: mensalidades ou acordos?", r: "Sempre priorizar os acordos. Se houver acordo em aberto ou vencido, trate o acordo antes das mensalidades." },
    { p: "Como negociar um acordo em aberto ou vencido?", r: "Primeiro consulte a Política de Negociação. Acordos não podem ser reparcelados em boleto: a regularização deve ser à vista ou no cartão de crédito. Se o aluno não tiver condição de quitar o saldo nessas modalidades, ofereça o pagamento das parcelas individualmente, uma a uma. Enquanto houver parcelas vencidas, a matrícula não será liberada." },
    { p: "Enviei um template no CRM. Como confirmar o envio?", r: "Feche o cadastro do aluno, abra novamente e confirme se a mensagem ficou registrada como enviada." },
    { p: "O aluno diz que está processando a Ulbra. O que fazer?", r: "Solicitar sempre o número do processo e encaminhar para Amanda ADM. Não discutir o processo nem emitir opinião jurídica." },
  ];

  return (
    <>
      <TituloSecao
        emoji="❓"
        titulo="Dúvidas Frequentes"
        sub="Respostas rápidas para situações operacionais recorrentes."
      />
      <div style={S.grade2}>
        {itens.map((it) => (
          <Card key={it.p}>
            <h3 style={S.h3}>{it.p}</h3>
            <p style={S.paragrafo}>{it.r}</p>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ===================== Honorários e Taxas ===================== */

function SecaoHonorarios() {
  return (
    <>
      <TituloSecao emoji="💰" titulo="Honorários e Taxas" />
      <div style={S.grade3}>
        <Card style={{ textAlign: "center" }}><div style={S.numeroGrande}>8%</div><div style={S.labelNumero}>Honorários</div><p style={S.paragrafo}>Conforme política vigente para débitos acima de 30 dias.</p></Card>
        <Card style={{ textAlign: "center" }}><div style={S.numeroGrande}>1% a.m.</div><div style={S.labelNumero}>Juros</div><p style={S.paragrafo}>Conforme regra vigente.</p></Card>
        <Card style={{ textAlign: "center" }}><div style={S.numeroGrande}>2%</div><div style={S.labelNumero}>Multa</div><p style={S.paragrafo}>Conforme regra vigente.</p></Card>
        <Card style={{ textAlign: "center" }}><div style={S.numeroGrande}>IGPM</div><div style={S.labelNumero}>Correção monetária</div><p style={S.paragrafo}>Aplicado conforme regra vigente do contrato.</p></Card>
      </div>
      <Card><h3 style={S.h3}>Como funciona a composição</h3><p style={S.paragrafo}>Quando aplicável, a composição do débito considera principal, juros, multa, correção e honorários de cobrança.</p><ul style={{...S.lista,marginTop:10}}><li><strong>À vista:</strong> honorários entram na quitação conforme a composição do pagamento.</li><li><strong>Cartão:</strong> honorários fazem parte da negociação conforme a regra vigente.</li><li><strong>Parcelamento:</strong> os honorários acompanham a composição do acordo quando aplicável.</li></ul></Card>
    </>
  );
}

/* ===================== Meta de Honorários ===================== */

// As faixas ficavam ESCRITAS A MAO aqui, e eram as de julho (38.000 / 45.000 /
// 52.000 / 60.000) -- a operacao leu meta errada de agosto ate 11/09/2026.
// Agora vem de metas_projecao, pela RPC portal_meta_do_mes: aquela tabela e
// restrita a gestao pela RLS, e a RPC expoe ao operador so a meta operacional e
// as faixas.
//
// Primeira faixa comeca em ZERO. O cadastro guarda 0,01 apenas para nao empatar
// com a faixa anterior; a gestao confirmou a regra em 11/09/2026.
const moedaBR = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const pctBR = (v) =>
  `${Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

const mesPorExtenso = (mes) => {
  const nomes = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const [ano, m] = String(mes || "").split("-");
  const i = parseInt(m, 10) - 1;
  return nomes[i] ? `${nomes[i]} de ${ano}` : mes;
};

function SecaoMeta() {
  const [meta, setMeta] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let vivo = true;
    supabase.rpc("portal_meta_do_mes").then(({ data, error }) => {
      if (!vivo) return;
      setCarregando(false);
      if (error) { setErro("Não foi possível carregar a meta do mês."); return; }
      setMeta(data || null);
    });
    return () => { vivo = false; };
  }, []);

  if (carregando) return <Carregando texto="Carregando a meta do mês…" />;

  const faixas = meta?.faixas || [];
  const semMeta = !meta || meta.sem_meta || !faixas.length;

  return (
    <>
      <TituloSecao
        emoji="🎯"
        titulo="Meta do mês"
        sub={meta?.mes ? `Referência: ${mesPorExtenso(meta.mes)}.` : "Faixas de comissão do mês."}
      />

      {erro ? <Card><p style={S.paragrafo}>{erro}</p></Card> : null}

      {!semMeta && meta.meta_operacional != null ? (
        <Card>
          <h3 style={S.h3}>Meta operacional da equipe</h3>
          <p style={{ ...S.paragrafo, fontSize: 30, fontWeight: 800, color: "var(--rv-tinta)", margin: "4px 0 0" }}>
            {moedaBR(meta.meta_operacional)}
          </p>
        </Card>
      ) : null}

      <Card>
        <h3 style={S.h3}>Faixas de comissão</h3>
        {semMeta ? (
          <p style={S.paragrafo}>
            A meta deste mês ainda não foi cadastrada. Assim que a gestão lançar,
            ela aparece aqui automaticamente.
          </p>
        ) : (
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Honorário no mês</th>
                <th style={S.thNum}>Percentual</th>
              </tr>
            </thead>
            <tbody>
              {faixas.map((f) => (
                <tr key={f.n}>
                  <td style={S.td}>
                    {f.ate == null
                      ? `Acima de ${moedaBR(f.de)}`
                      : Number(f.de) === 0
                        ? `Até ${moedaBR(f.ate)}`
                        : `De ${moedaBR(f.de)} a ${moedaBR(f.ate)}`}
                  </td>
                  <td style={S.tdNum}><strong>{pctBR(f.percentual)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h3 style={S.h3}>📌 Foco do mês</h3>
        <p style={S.paragrafo}>
          Trabalhar com organização, confirmar acordos, seguir os procedimentos corretos no Prime e manter
          registros completos no CRM para dar agilidade às baixas.
        </p>
      </Card>
    </>
  );
}

/* ===================== LGPD e Conduta ===================== */

function SecaoLgpd() {
  return (
    <>
      <TituloSecao emoji="🔐" titulo="LGPD e Conduta" />
      <Card><h3 style={S.h3}>Confirmação e proteção de dados</h3><ul style={S.lista}><li>Confirmar os 3 primeiros dígitos do CPF antes de tratar informações financeiras ou acadêmicas.</li><li>Não compartilhar dados do aluno fora dos canais autorizados.</li><li>Não expor CPF completo.</li><li>Não usar número pessoal para atendimento.</li></ul></Card>
      <Card><h3 style={S.h3}>Atendimento a terceiros</h3><p style={S.paragrafo}>Informações devem ser tratadas diretamente com o titular. Não informar a terceiros valores, boletos, contratos, dados acadêmicos, acordos, telefones, e-mails cadastrados ou outras informações financeiras.</p><p style={{...S.paragrafo,marginTop:10}}><strong>Resposta de apoio:</strong> “Por questões de segurança e proteção de dados, as informações podem ser tratadas apenas diretamente com o titular.”</p></Card>
      <Card><h3 style={S.h3}>Segurança da informação</h3><ul style={S.lista}><li>Não compartilhar acessos internos.</li><li>Não salvar dados em aparelhos pessoais.</li><li>Não enviar dados em grupos.</li><li>Conferir o destinatário antes de enviar documentos.</li><li>Bloquear a tela ao se afastar.</li></ul></Card>
      <Card><h3 style={S.h3}>Conduta no acionamento</h3><ul style={S.lista}><li>Verificar histórico antes de acionar.</li><li>Não acionar casos com jurídico, cancelamento ou bloqueio.</li><li>Registrar a tratativa no CRM.</li><li>Não prometer condições sem aprovação.</li><li>Não utilizar linguagem agressiva ou constrangedora.</li></ul></Card>
    </>
  );
}

/* ===================== Indicadores ===================== */

function SecaoIndicadores() {
  const itens = [
    { emoji: "☎️", titulo: "Contatos", desc: "Volume e qualidade dos acionamentos." },
    { emoji: "🤝", titulo: "Acordos", desc: "Acordos confirmados e registrados." },
    { emoji: "🔗", titulo: "Links e termos", desc: "Pendências e retornos administrativos." },
    { emoji: "✅", titulo: "Baixas", desc: "Comprovantes e finalizações corretas." },
  ];
  return (
    <>
      <TituloSecao emoji="📊" titulo="Indicadores" />
      <div style={S.grade4}>
        {itens.map((it) => (
          <Card key={it.titulo} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>{it.emoji}</div>
            <h3 style={{ ...S.h3, marginBottom: 6 }}>{it.titulo}</h3>
            <p style={S.paragrafo}>{it.desc}</p>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ===================== Pontos do Dia a Dia ===================== */

function SecaoRotina() {
  const grupos = [
    {
      titulo: "Registro no CRM",
      itens: [
        "Toda movimentação ou informação importante deve ser registrada.",
        "Registrar proposta, contraproposta, objeção, retorno combinado, encaminhamento e documentos solicitados.",
        "O registro deve permitir acompanhamento pelo operacional, supervisão, ADM e gestão.",
      ],
    },
    {
      titulo: "Negociação",
      itens: [
        "Priorizar sempre acordos antes de mensalidades.",
        "Na negociação de acordos, consultar a Política de Negociação antes de apresentar qualquer condição.",
        "Acordos não podem ser reparcelados em boleto: somente pagamento à vista ou cartão de crédito.",
        "Se o aluno não tiver condição, oferecer o pagamento das parcelas individualmente, uma a uma.",
        "Enquanto houver parcelas vencidas do acordo, a matrícula não será liberada.",
        "Nunca incluir parcelas de matrícula nas negociações.",
        "No Tipo de Parcela, diferenciar corretamente: Acordo, Matrícula ou Mensalidade.",
      ],
    },
    {
      titulo: "Acordos e honorários",
      itens: [
        "Ao revisar acordo antigo, conferir se o honorário já foi incluído.",
        "Se não houver honorário registrado, incluir conforme o procedimento aplicável.",
        "Se já houver honorário, é expressamente proibido incluir novamente.",
      ],
    },
    {
      titulo: "Encaminhamentos",
      itens: [
        "Bolsa ou financiamento: ADM → avaliação do Financeiro.",
        "Aluno menciona processo contra a Ulbra: pedir número do processo → Amanda ADM.",
        "Saldo de matrícula inferior a R$ 20,00: não cobrar → Financeiro.",
        "Saldo de matrícula acima de R$ 20,00: a cobrança pode ser realizada.",
      ],
    },
    {
      titulo: "Contato com o aluno",
      itens: [
        "Confirmar se o telefone está correto no CRM.",
        "Consultar números mais atualizados disponíveis no ReATIVA One.",
        "Sem contato por telefone/WhatsApp: enviar e-mail e registrar a tentativa.",
        "Após envio de template, fechar e reabrir o cadastro para confirmar que a mensagem foi enviada.",
      ],
    },
  ];

  return (
    <>
      <TituloSecao
        emoji="📌"
        titulo="Pontos Importantes do Dia a Dia"
        sub="Regras operacionais que precisam estar presentes em todo atendimento."
      />
      <Aviso tom="info">
        <strong>Regra central:</strong> se uma informação pode influenciar o próximo atendimento, a negociação
        ou uma decisão de supervisão/ADM/gestão, registre no CRM.
      </Aviso>

      <div style={S.grade2}>
        {grupos.map((grupo) => (
          <Card key={grupo.titulo}>
            <h3 style={S.h3}>{grupo.titulo}</h3>
            <ul style={S.listaChecklist}>
              {grupo.itens.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </Card>
        ))}
      </div>

      <Card style={S.cardLimiteAtuacao}>
        <span style={S.cardTag}>LIMITE DE ATUAÇÃO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>A ReATIVA realiza cobrança e negociação financeira</h3>
        <p style={S.paragrafo}>
          Assuntos de matrícula, documentos, bolsas, protocolos, questões acadêmicas ou demandas de outras
          áreas devem ser direcionados ao setor correspondente. Registre no CRM a orientação e o encaminhamento.
        </p>
      </Card>
    </>
  );
}

/* ===================== Matrícula e WebAluno ===================== */

function SecaoAcademico() {
  return (
    <>
      <TituloSecao
        emoji="🎓"
        titulo="Matrícula, WebAluno e Documentos"
        sub="Orientações acadêmicas de apoio. A ReATIVA trata a parte financeira; demais decisões pertencem às áreas responsáveis da Ulbra."
      />

      <div style={S.grade2}>
        <Card>
          <span style={S.cardTag}>MATRÍCULA / REMATRÍCULA</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno deseja realizar matrícula</h3>
          <p style={S.paragrafo}>
            Sem pendências impeditivas, o aluno pode realizar a matrícula diretamente pelo WebAluno.
            Se solicitar atendimento ou auxílio, direcionar o caso para a coluna <strong>Rematrícula</strong> no Kanban.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>ANTECIPAÇÃO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Antecipação de semestre</h3>
          <p style={S.paragrafo}>
            A matrícula de um próximo semestre pode ser aberta antes do início das aulas. Ao efetivar a matrícula,
            as parcelas daquele semestre podem começar a ser geradas antecipadamente.
          </p>
          <p style={{ ...S.paragrafo, marginTop: 8 }}>
            Se o aluno alegar antecipação, verifique em <strong>Títulos a Receber</strong> se consta um valor pago
            em uma única parcela, exibido em azul. Depois encaminhe ao ADM para redirecionamento à unidade.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>TRANCAMENTO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Existe trancamento retroativo?</h3>
          <p style={S.paragrafo}>
            Não. O trancamento possui prazo máximo conforme o calendário acadêmico. Se o cancelamento ou
            trancamento ocorrer após o vencimento de uma parcela, essa parcela é considerada devida.
            Oriente o aluno a acompanhar o parecer do protocolo realizado.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>DOCUMENTOS</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Declaração IRPF e Contrato Educacional</h3>
          <ul style={S.listaCompacta}>
            <li><strong>Declaração IRPF:</strong> WebAluno → Posição Financeira → Declaração IRPF → ano-base.</li>
            <li><strong>Contrato Educacional:</strong> WebAluno → Posição Financeira → Contrato Educacional.</li>
          </ul>
        </Card>

        <Card>
          <span style={S.cardTag}>COMPROVANTE</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno solicita comprovante de pagamento</h3>
          <p style={S.paragrafo}>
            O próprio boleto pago pode ser usado como comprovante; em pagamento via Pix, utilizar o comprovante
            do Pix. Se precisar de documento emitido pela instituição, orientar solicitação via protocolo no WebAluno.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>CONTATO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Confirme os dados do aluno</h3>
          <p style={S.paragrafo}>
            Sempre confirme se o telefone está correto. O ReATIVA One pode possuir números mais atualizados.
            Se não conseguir contato por telefone ou WhatsApp, envie e-mail e registre a tentativa no CRM.
          </p>
        </Card>
      </div>

      <TituloSecao emoji="💬" titulo="Frases prontas" sub="Modelos para adaptar conforme o caso." />
      <BlocoCopiar
        titulo="Matrícula / rematrícula"
        texto="Você pode realizar sua matrícula diretamente pelo WebAluno, desde que não existam pendências impeditivas. Caso precise de atendimento ou auxílio no processo, posso encaminhar sua solicitação para o setor responsável pela rematrícula."
      />
      <BlocoCopiar
        titulo="Antecipação de matrícula"
        texto="A matrícula do próximo semestre pode ser disponibilizada antecipadamente. Quando ela é efetivada, as parcelas referentes ao semestre futuro podem ser geradas antes do início das aulas. Por isso, é possível visualizar cobranças do próximo período ainda no semestre atual."
      />
    </>
  );
}

/* ===================== Cursos Ulbra ===================== */

function SecaoCursos() {
  const cursos = [
    "Administração","Agronegócio","Agronomia","Análise e Desenvolvimento de Sistemas","Arquitetura e Urbanismo",
    "Biomedicina","Ciência da Computação","Ciências Biológicas","Ciências Contábeis","Comércio Exterior",
    "Comunicação Social - Publicidade e Propaganda","Design","Design Digital","Direito","Educação Física",
    "Enfermagem","Engenharia Agrícola","Engenharia Ambiental e Sanitária","Engenharia Civil","Engenharia de Minas",
    "Engenharia de Produção","Engenharia de Software","Engenharia Elétrica","Engenharia Mecânica","Engenharia Mecânica Automotiva",
    "Engenharia Química","Estética e Cosmética","Farmácia","Fisioterapia","Fonoaudiologia",
    "Gestão Comercial","Gestão da Produção Industrial","Gestão da Tecnologia da Informação","Gestão de Recursos Humanos",
    "Gestão do Agronegócio","Gestão Financeira","Gestão Pública","Inteligência Artificial","Jogos Digitais","Jornalismo",
    "Letras - Inglês e Literaturas da Língua Inglesa","Logística","Marketing com Ênfase em Mídias Digitais","Matemática",
    "Medicina","Medicina Veterinária","Mídias Sociais Digitais","Nutrição","Odontologia","Pedagogia",
    "Pilotagem Profissional de Aeronaves","Processos Gerenciais","Psicologia","Química","Química Industrial",
    "Redes de Computadores","Secretariado Executivo Trilíngue","Segurança da Informação","Segurança no Trabalho","Serviço Social",
    "Serviços Jurídicos e Notariais","Sistemas de Informação","Teologia","Terapia Ocupacional","Transporte Aéreo"
  ];

  return (
    <>
      <TituloSecao emoji="🎓" titulo="Cursos Ulbra" sub="Cursos de graduação encontrados nas ofertas atuais da Ulbra. A disponibilidade varia por unidade e modalidade." />
      <Aviso tom="info">
        A Ulbra oferece cursos presenciais, EAD e semipresenciais. Antes de confirmar ao aluno que um curso está disponível na unidade desejada, consulte o Vestibular oficial.
      </Aviso>
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px 16px" }}>
          {cursos.map((curso) => (
            <div key={curso} style={{ fontSize: 13, color: "var(--rv-texto)", padding: "6px 0", borderBottom: "1px solid var(--rv-borda-suave)" }}>
              {curso}
            </div>
          ))}
        </div>
      </Card>
      <a href="https://www.ulbra.br/vestibular" target="_blank" rel="noreferrer" style={S.botaoSecundario}>Consultar Vestibular / cursos por unidade</a>
    </>
  );
}

/* ===================== Bolsas e Financiamentos ===================== */

function SecaoBeneficios() {
  const oficiais = [
    ["Novo Fies", "Financiamento estudantil para graduação presencial, sujeito às regras oficiais vigentes."],
    ["Prouni", "Programa de bolsas do Governo Federal, sujeito ao processo seletivo e às regras do MEC."],
    ["CredIES Ulbra", "Crédito educativo divulgado pela Ulbra em parceria com a Fundacred."],
    ["Mais Acesso", "Alternativa de crédito divulgada pela Ulbra em parceria com a Fundacred."],
  ];

  return (
    <>
      <TituloSecao
        emoji="🎟️"
        titulo="Bolsas, Créditos e Financiamentos"
        sub="O operador identifica a alegação e encaminha; a validação do benefício é feita pelo ADM/Financeiro."
      />

      <Aviso>
        <strong>Regra operacional:</strong> se o aluno alegar bolsa, FIES, Prouni, Quero Bolsa, UDEBANK,
        EDUCRED ou qualquer outro benefício, registre a informação no CRM e encaminhe ao ADM.
        O ADM solicitará a avaliação do Financeiro da Ulbra.
      </Aviso>

      <div style={S.grade2}>
        {oficiais.map(([nome, desc]) => (
          <Card key={nome}>
            <span style={S.cardTag}>PROGRAMA / CRÉDITO</span>
            <h3 style={{ ...S.h3, marginTop: 8 }}>{nome}</h3>
            <p style={S.paragrafo}>{desc}</p>
          </Card>
        ))}
        <Card>
          <span style={S.cardTag}>OUTROS NOMES NO ATENDIMENTO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Quero Bolsa • UDEBANK • EDUCRED</h3>
          <p style={S.paragrafo}>
            O nome informado pelo aluno não confirma que o benefício esteja ativo ou aplicado ao contrato.
            Registrar e encaminhar ao ADM para validação pelo Financeiro.
          </p>
        </Card>
      </div>

      <Card>
        <h3 style={S.h3}>O que o operador não deve fazer</h3>
        <ul style={S.listaCompacta}>
          <li>Não confirmar percentual de bolsa sem validação.</li>
          <li>Não informar que o benefício foi perdido ou cancelado.</li>
          <li>Não lançar, retirar ou alterar benefício.</li>
          <li>Não prometer regularização automática do saldo.</li>
        </ul>
      </Card>

      <div style={S.botoesLinha}>
        <a href="https://www.ulbra.br/beneficios" target="_blank" rel="noreferrer" style={S.botaoSecundario}>Benefícios Ulbra</a>
        <a href="https://www.ulbra.br/fies" target="_blank" rel="noreferrer" style={S.botaoSecundario}>FIES</a>
        <a href="https://www.ulbra.br/prouni" target="_blank" rel="noreferrer" style={S.botaoSecundario}>Prouni</a>
      </div>
    </>
  );
}

/* ===================== Sistemas e Planilhas ===================== */

function SecaoSistemas() {
  const sistemas = [
    { emoji: "🟢", titulo: "ReATIVA One", tipo: "CRM OPERACIONAL", desc: "Carteira, atendimentos, negociações, retornos, registros e acompanhamento da operação.", href: "/" },
    { emoji: "💬", titulo: "CRM de Mensageria", tipo: "MENSAGERIA", desc: "Envio e consulta de mensagens e contatos relacionados à operação.", href: "https://crm.ulbra.ai/" },
    { emoji: "✉️", titulo: "Gmail", tipo: "E-MAIL", desc: "Canal institucional e alternativa de contato quando necessário.", href: "https://mail.google.com/" },
    { emoji: "📌", titulo: "Prime", tipo: "FINANCEIRO", desc: "Consulta e confirmação de informações financeiras e de acordos.", href: null },
    { emoji: "🎓", titulo: "WebAluno", tipo: "PORTAL DO ALUNO", desc: "Posição financeira, documentos, protocolos, matrícula e serviços acadêmicos.", href: "https://www.ulbra.br/webaluno/" },
  ];

  return (
    <>
      <TituloSecao
        emoji="🚀"
        titulo="Sistemas e Planilhas"
        sub="Para que serve cada ferramenta e onde consultar."
      />

      <div style={S.grade3}>
        {sistemas.map((s) => (
          <Card key={s.titulo} style={S.cardFerramenta}>
            <div style={S.ferramentaTopo}>
              <span style={S.ferramentaEmoji}>{s.emoji}</span>
              <span style={S.cardTag}>{s.tipo}</span>
            </div>
            <h3 style={{ ...S.h3, marginTop: 12 }}>{s.titulo}</h3>
            <p style={S.paragrafo}>{s.desc}</p>
            {s.href ? (
              <a
                href={s.href}
                target={s.href.startsWith("http") ? "_blank" : undefined}
                rel="noreferrer"
                style={{ ...S.botaoSecundario, marginTop: 14 }}
              >
                Abrir sistema
              </a>
            ) : (
              <p style={S.observacao}>Utilize o acesso oficial disponibilizado para a equipe.</p>
            )}
          </Card>
        ))}
      </div>

      <TituloSecao emoji="📊" titulo="Planilhas utilizadas" sub="Materiais de apoio operacional." />
      <div style={S.grade2}>
        <Card>
          <span style={S.cardTag}>PLANILHA OFICIAL</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Cálculo de desconto</h3>
          <p style={S.paragrafo}>Apoio para cálculo quando aplicável. Utilize sempre dentro das regras vigentes.</p>
          <a href="https://docs.google.com/spreadsheets/d/19g0v1kikqvMLTHEIZHTg8NKUt6TOxdv2Aiyk41L1Tf4/edit?usp=sharing" target="_blank" rel="noreferrer" style={{ ...S.botaoSecundario, marginTop: 12 }}>
            Abrir planilha
          </a>
        </Card>
        <Card>
          <span style={S.cardTag}>BASE DE APOIO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Planilha Base</h3>
          <p style={S.paragrafo}>Base operacional compartilhada pela gestão. Utilize somente a versão oficial disponibilizada à equipe.</p>
        </Card>
      </div>
    </>
  );
}



function SecaoLinks() {
  const links = [
    {titulo:"CRM de Mensageria",href:"https://crm.ulbra.ai/"},
    {titulo:"Gmail",href:"https://mail.google.com/"},
    {titulo:"WebAluno",href:"https://www.ulbra.br/webaluno/"},
    {titulo:"Vestibular / Cursos Ulbra",href:"https://www.ulbra.br/vestibular"},
    {titulo:"Benefícios Ulbra",href:"https://www.ulbra.br/beneficios"},
    {titulo:"FIES",href:"https://www.ulbra.br/fies"},
    {titulo:"Prouni",href:"https://www.ulbra.br/prouni"},
    {titulo:"Cálculo de desconto",href:"https://docs.google.com/spreadsheets/d/19g0v1kikqvMLTHEIZHTg8NKUt6TOxdv2Aiyk41L1Tf4/edit?usp=sharing"},
  ];
  return (
    <>
      <TituloSecao emoji="🔗" titulo="Links Úteis" />
      <div style={S.grade3}>{links.map(l=><Card key={l.titulo}><h3 style={S.h3}>{l.titulo}</h3><a href={l.href} target="_blank" rel="noreferrer" style={S.botaoSecundario}>Abrir</a></Card>)}</div>
    </>
  );
}

/* ===================== Biblioteca ===================== */

function SecaoBiblioteca({ ir }) {
  const itens = [
    { emoji: "📄", titulo: "Políticas", desc: "Regras vigentes e condições de negociação.", id: "politica" },
    { emoji: "💬", titulo: "Scripts", desc: "Mensagens prontas e modelos de atendimento.", id: "mensagens" },
    { emoji: "🔥", titulo: "Objeções", desc: "Apoio em negociações e recuperação de crédito.", id: "objecoes" },
    { emoji: "🧠", titulo: "Treinamento", desc: "Conteúdos da Universidade Ulbra e desenvolvimento da equipe." },
    { emoji: "📌", titulo: "Procedimentos", desc: "Termos, links, comprovantes e baixas." },
    { emoji: "💡", titulo: "Melhorias", desc: "Use o Painel de Sugestões para propor ajustes.", id: "sugestoes" },
  ];
  return (
    <>
      <TituloSecao emoji="📚" titulo="Biblioteca" />
      <div style={S.grade3}>
        {itens.map((it) => (
          <button
            key={it.titulo}
            type="button"
            onClick={() => it.id && ir(it.id)}
            style={{ ...S.cardAtalho, cursor: it.id ? "pointer" : "default" }}
          >
            <span style={S.cardAtalhoEmoji}>{it.emoji}</span>
            <strong style={S.cardAtalhoTitulo}>{it.titulo}</strong>
            <span style={S.cardAtalhoDesc}>{it.desc}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ===================== Contatos Úteis ===================== */

function SecaoContatos() {
  const telefones = [
    ["ReATIVA","(51) 99274-1192"],
    ["J.A. Rezende","(51) 2117-9521"],
    ["Cobrafix","0800 888 0097"],
    ["Central de Relacionamento","Mesmo número da ReATIVA"],
    ["Ramal Central de Relacionamento","101"],
    ["Portaria Prédio 10","2278"],
    ["Comercial","102"],
    ["Central de Relacionamento presencial","3576"],
    ["Jurídico ReATIVA","(69) 99919-7998"]
  ];
  const unidades = [
    ["Cachoeira do Sul",["ulbracachoeiradosul@ulbra.br"]],
    ["Canoas",["financeiroacademico.canoas@ulbra.br"]],
    ["Carazinho",["financeiro.czo@ulbra.br","secgeral.czo@ulbra.br"]],
    ["EAD",["financeiro.ead@ulbra.br"]],
    ["Gravataí",["financeiroacademico.canoas@ulbra.br"]],
    ["Guaíba",["tanisa.nogueira@ulbra.br"]],
    ["Itumbiara",["guilherme.nascimento@ulbra.br","coordfinanc.itb@ulbra.br"]],
    ["Manaus",["financeiro.ceulm@ulbra.br","secretariamao@ulbra.br"]],
    ["Palmas",["patricia.dasilva@ulbra.br"]],
    ["Porto Alegre",["financeiroacademico.canoas@ulbra.br"]],
    ["Santa Maria",["cristiane.rodrigues@ulbra.br"]],
    ["Santarém",["eunice.silva@ulbra.br","tesouraria.stm@ulbra.br"]],
    ["São Jerônimo",["daniel.geremias@ulbra.br"]],
    ["Torres",["tesourariator@ulbra.br"]]
  ];
  const juridico = [
    ["Dra. Giovana","giovana8fs@aelbra.com.br"],
    ["Bruno","bruno.a.albertini@aelbra.com.br"]
  ];

  return (
    <>
      <TituloSecao emoji="☎️" titulo="Contatos Úteis" sub="Telefones, ramais e e-mails de apoio à operação." />
      <div style={S.grade3}>
        <Card><h3 style={S.h3}>Supervisão / Gestão</h3><p style={S.paragrafo}>Dúvidas de política, exceções, conduta e direcionamentos operacionais.</p></Card>
        <Card><h3 style={S.h3}>Administrativo</h3><p style={S.paragrafo}>Termos, links, comprovantes, bolsas, encaminhamentos financeiros, processos mencionados pelo aluno e demais procedimentos administrativos.</p></Card>
      </div>

      <Card>
        <h3 style={S.h3}>Telefones e ramais</h3>
        <table style={S.tabela}><tbody>{telefones.map(([n,c])=><tr key={n}><td style={S.td}><strong>{n}</strong></td><td style={S.td}>{c}</td></tr>)}</tbody></table>
      </Card>

      <Card>
        <h3 style={S.h3}>Jurídico</h3>
        <p style={{ ...S.paragrafo, marginBottom: 10 }}><strong>Telefone Jurídico ReATIVA:</strong> (69) 99919-7998</p>
        {juridico.map(([nome,email]) => (
          <div key={email} style={{ marginBottom: 6 }}>
            <strong>{nome}:</strong> <a href={`mailto:${email}`} style={S.linkContato}>{email}</a>
          </div>
        ))}
      </Card>

      <Card>
        <h3 style={S.h3}>E-mails por unidade</h3>
        <div style={S.grade3}>{unidades.map(([u,emails])=><div key={u} style={S.contatoUnidade}><strong>{u}</strong>{emails.map(e=><a key={e} href={`mailto:${e}`} style={S.linkContato}>{e}</a>)}</div>)}</div>
      </Card>
    </>
  );
}

/* ===================== Painel de Sugestões ===================== */

function SecaoSugestoes() {
  const [enviado, setEnviado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [form, setForm] = useState({
    nome: "",
    area: "",
    tipo: "",
    prioridade: "",
    tela: "",
    descricao: "",
  });

  function atualizar(campo, valor) {
    setForm((f) => ({ ...f, [campo]: valor }));
  }

  async function enviar(e) {
    e.preventDefault();
    if (!form.area || !form.tipo || !form.descricao.trim()) {
      setErro("Preencha ao menos Área, Tipo e Descrição.");
      return;
    }
    setErro("");
    setEnviando(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("sugestoes").insert({
      nome: form.nome.trim() || null,
      autor_email: userData?.user?.email || null,
      area: form.area,
      tipo: form.tipo,
      prioridade: form.prioridade || null,
      tela: form.tela.trim() || null,
      descricao: form.descricao.trim(),
    });
    setEnviando(false);
    if (error) {
      setErro("Não foi possível enviar agora. Tente novamente.");
      return;
    }
    setEnviado(true);
  }

  return (
    <>
      <TituloSecao emoji="💡" titulo="Painel de Sugestões" sub="Envie ideias, ajustes e melhorias para o Sistema ReATIVA ou para o Portal Reativa." />
      <Card>
        <p style={S.avisoCanal}>
          ⚠️ <strong>Canal oficial.</strong> Registre erros, dúvidas e sugestões só por aqui — é assim que a demanda entra na fila e é acompanhada. Pedidos por WhatsApp, e-mail ou verbais não entram para tratativa.
        </p>
      </Card>
      <Card>
        {enviado ? (
          <p style={S.paragrafo}>✅ Sugestão enviada, obrigado!</p>
        ) : (
          <form onSubmit={enviar} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {erro && <p style={{ ...S.paragrafo, color: "var(--rv-vermelho)" }}>{erro}</p>}
            <Campo label="Nome">
              <input style={S.input} placeholder="Seu nome" value={form.nome} onChange={(e) => atualizar("nome", e.target.value)} />
            </Campo>
            <Campo label="Área">
              <select style={S.input} value={form.area} onChange={(e) => atualizar("area", e.target.value)}>
                <option value="">Selecione</option>
                <option>Sistema ReATIVA</option>
                <option>CRM Mensageria</option>
                <option>Portal Reativa</option>
              </select>
            </Campo>
            <Campo label="Tipo">
              <select style={S.input} value={form.tipo} onChange={(e) => atualizar("tipo", e.target.value)}>
                <option value="">Selecione</option>
                <option>Erro</option>
                <option>Melhoria</option>
                <option>Nova ideia</option>
                <option>Ajuste de informação</option>
                <option>Dúvida</option>
              </select>
            </Campo>
            <Campo label="Prioridade">
              <select style={S.input} value={form.prioridade} onChange={(e) => atualizar("prioridade", e.target.value)}>
                <option value="">Selecione</option>
                <option>Baixa</option>
                <option>Média</option>
                <option>Alta</option>
              </select>
            </Campo>
            <Campo label="Tela ou seção relacionada">
              <input style={S.input} placeholder="Ex: Minha Carteira" value={form.tela} onChange={(e) => atualizar("tela", e.target.value)} />
            </Campo>
            <Campo label="Descrição da sugestão">
              <textarea style={{ ...S.input, minHeight: 90 }} placeholder="Descreva sua sugestão..." value={form.descricao} onChange={(e) => atualizar("descricao", e.target.value)} />
            </Campo>
            <button type="submit" disabled={enviando} style={{ ...S.botaoPrimario, border: "none", cursor: "pointer" }}>
              {enviando ? "Enviando..." : "Enviar sugestão"}
            </button>
          </form>
        )}
      </Card>

      <ErrosReportados />
    </>
  );
}

function ErrosReportados() {
  const [lista, setLista] = useState([]);
  const [carregando, setCarregando] = useState(true);

  async function carregar() {
    setCarregando(true);
    const { data } = await supabase.rpc("listar_erros_reportados");
    setLista(data || []);
    setCarregando(false);
  }

  useEffect(() => {
    carregar();
  }, []);

  return (
    <>
      <TituloSecao
        emoji="🐞"
        titulo="Erros já reportados"
        sub="Erros marcados como visíveis pela equipe. Antes de reportar, confira se já está aqui."
      />
      <Card>
        <button style={{ ...S.botaoSecundario, marginBottom: 12 }} onClick={carregar}>Atualizar</button>
        {carregando ? (
          <Carregando texto="Carregando…" />
        ) : lista.length === 0 ? (
          <p style={S.paragrafo}>Nenhum erro reportado no momento.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {lista.map((e) => {
              const st = STATUS_ERRO[e.status] || STATUS_ERRO.NOVA;
              return (
                <div key={e.id} style={S.erroItem}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ ...S.erroBadge, background: st.bg, color: st.cor }}>{st.rotulo}</span>
                    {e.tela && <span style={S.erroTela}>{e.tela}</span>}
                    <span style={S.erroData}>{new Date(e.criado_em).toLocaleDateString("pt-BR")}</span>
                  </div>
                  <p style={S.erroDesc}>{e.descricao}</p>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

function Campo({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={S.labelCampo}>{label}</span>
      {children}
    </label>
  );
}

/* ===================== Cultura Reativa ===================== */

function SecaoCultura() {
  const frases = [
    "Foco no objetivo, força para vencer.",
    "Juntos somos mais fortes.",
    "Disciplina hoje, resultados sempre.",
    "Pequenas atitudes, grandes resultados.",
    "Excelência é o nosso padrão.",
    "Faça seu melhor em tudo que fizer.",
    "Ideias inovam, atitudes transformam.",
    "Compromisso que gera confiança e resultados.",
    "Atendimento com excelência gera confiança; confiança gera acordos.",
  ];
  return (
    <>
      <TituloSecao emoji="💚" titulo="Cultura Reativa" sub="Frases, valores e lembretes para manter a equipe alinhada, motivada e focada em resultado." />
      <div style={S.grade3}>
        {frases.map((f) => (
          <Card key={f} style={{ ...S.cardFrase }}>
            <p style={S.frase}>&ldquo;{f}&rdquo;</p>
          </Card>
        ))}
      </div>
    </>
  );
}

/* ===================== Nossa História ===================== */

function SecaoHistoria() {
  const cards = [
    { emoji: "📸", titulo: "Momento da equipe" },
    { emoji: "💚", titulo: "Campanha Reativa" },
    { emoji: "🏆", titulo: "Conquistas do mês" },
    { emoji: "✨", titulo: "Bastidores da operação" },
  ];
  return (
    <>
      <TituloSecao emoji="📸" titulo="Nossa História" sub="Momentos da equipe Reativa, conquistas, campanhas e bastidores." />
      <div style={S.grade4}>
        {cards.map((c) => (
          <div key={c.titulo} style={S.cardHistoria}>
            <span style={{ fontSize: 30 }}>{c.emoji}</span>
            <strong style={{ fontSize: 13 }}>{c.titulo}</strong>
          </div>
        ))}
      </div>
    </>
  );
}

/* ===================== Estilos ===================== */

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "var(--rv-azul)";
const VERDE_ESCURO = "var(--rv-azul-texto)";
const BORDA = "var(--rv-borda)";

const S = {
  pagina: {
    minHeight: "100%",
    background: "var(--rv-fundo)",
    fontFamily: "Inter, system-ui, sans-serif",
    color: "var(--rv-texto)",
  },
  shell: { display: "flex", minHeight: "100vh", width: "100%" },

  sidebar: {
    width: 322,
    height: "100vh",
    position: "sticky",
    top: 0,
    flexShrink: 0,
    background: "var(--rv-superficie)",
    borderRight: `1px solid ${BORDA}`,
    display: "flex",
    flexDirection: "column",
    padding: "26px 18px 18px",
    boxSizing: "border-box",
    boxShadow: "4px 0 18px rgba(15,23,42,0.035)",
  },
  logoArea: { padding: "2px 10px 22px" },
  logoBox: { fontFamily: FONTE_TITULO, fontSize: 29, fontWeight: 900, letterSpacing: "-0.035em" },
  logoRe: { color: VERDE },
  logoAtiva: { color: "var(--rv-tinta)" },
  logoSub: { fontSize: 13, color: "var(--rv-texto-suave)", fontWeight: 700, marginTop: 3, letterSpacing: "0.03em" },

  buscaBox: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    marginBottom: 22,
  },
  buscaIcone: { position: "absolute", left: 12, color: "var(--rv-texto-fraco)", fontSize: 17, pointerEvents: "none" },
  buscaInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px 12px 39px",
    borderRadius: 12,
    border: `1px solid ${BORDA}`,
    background: "var(--rv-fundo-suave)",
    color: "var(--rv-texto-forte)",
    fontFamily: "inherit",
    fontSize: 14.5,
    outline: "none",
  },
  semResultado: { color: "var(--rv-texto-fraco)", fontSize: 13.5, padding: "14px 10px" },

  nav: { flex: 1, overflowY: "auto", paddingRight: 2 },
  navGrupo: { marginBottom: 21 },
  navGrupoLabel: {
    fontSize: 11.5,
    fontWeight: 900,
    letterSpacing: "0.12em",
    color: "var(--rv-texto-fraco)",
    marginBottom: 8,
    paddingLeft: 12,
    textTransform: "uppercase",
  },
  navItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "1px solid transparent",
    color: "var(--rv-texto)",
    padding: "11px 13px",
    borderRadius: 12,
    fontSize: 14.3,
    fontWeight: 650,
    cursor: "pointer",
    marginBottom: 4,
    transition: "all .15s ease",
  },
  navItemAtivo: {
    background: "var(--rv-azul-fundo)",
    color: VERDE_ESCURO,
    border: "1px solid var(--rv-azul-borda)",
    fontWeight: 800,
  },
  sidebarRodape: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 13.5,
    color: "var(--rv-texto-fraco)",
    padding: "16px 10px 2px",
    borderTop: "1px solid var(--rv-borda-suave)",
  },

  conteudo: {
    flex: 1,
    width: "100%",
    maxWidth: 1360,
    margin: "0 auto",
    padding: "42px 52px 72px",
    boxSizing: "border-box",
  },

  hero: {
    background: "linear-gradient(135deg, var(--rv-superficie) 0%, var(--rv-azul-fundo) 100%)",
    border: "1px solid var(--rv-azul-borda)",
    borderRadius: 28,
    padding: "48px 50px",
    color: "var(--rv-tinta)",
    marginBottom: 18,
    boxShadow: "0 12px 36px rgba(15,23,42,0.06)",
    overflow: "hidden",
  },
  heroConteudo: { maxWidth: 860 },
  heroEyebrow: { fontSize: 12, fontWeight: 900, letterSpacing: "0.14em", color: VERDE_ESCURO },
  heroTitulo: {
    fontFamily: FONTE_TITULO,
    fontSize: 40,
    fontWeight: 850,
    margin: "10px 0 10px",
    letterSpacing: "-0.035em",
    lineHeight: 1.15,
    color: "var(--rv-tinta)",
  },
  heroTexto: { fontSize: 17, color: "var(--rv-texto-suave)", lineHeight: 1.65, maxWidth: 800 },
  heroAcoes: { display: "flex", gap: 12, flexWrap: "wrap", marginTop: 24 },

  statusGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
    gap: 16,
    marginBottom: 18,
  },
  statusCard: { marginBottom: 0, minHeight: 145, display: "flex", flexDirection: "column", justifyContent: "center" },
  statusCardDestaque: { background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)" },
  statusRotulo: { fontSize: 11.5, fontWeight: 900, color: "var(--rv-texto-fraco)", textTransform: "uppercase", letterSpacing: "0.07em" },
  statusValor: { fontFamily: FONTE_TITULO, fontSize: 24, color: "var(--rv-tinta)", marginTop: 7 },
  statusValorMenor: { fontFamily: FONTE_TITULO, fontSize: 21, color: "var(--rv-tinta)", marginTop: 7 },
  statusDescricao: { fontSize: 13.5, color: "var(--rv-texto-suave)", lineHeight: 1.5, marginTop: 7 },

  tituloSecaoBox: { marginBottom: 24, marginTop: 2 },
  tituloSecaoH1: { fontFamily: FONTE_TITULO, fontSize: 30, fontWeight: 850, color: "var(--rv-tinta)", margin: 0, letterSpacing: "-0.025em" },
  tituloSecaoSub: { color: "var(--rv-texto-suave)", fontSize: 15.5, marginTop: 8, lineHeight: 1.6 },
  secaoEyebrow: { fontSize: 11.5, fontWeight: 900, color: VERDE_ESCURO, letterSpacing: "0.1em" },
  h2: { fontFamily: FONTE_TITULO, fontSize: 25, color: "var(--rv-tinta)", margin: "6px 0 0", letterSpacing: "-0.02em" },
  blocoCabecalho: { display: "flex", justifyContent: "space-between", alignItems: "end", gap: 22, margin: "32px 0 18px" },
  blocoDescricao: { margin: "7px 0 0", color: "var(--rv-texto-suave)", fontSize: 14.5, lineHeight: 1.55 },
  linkAcao: { border: "none", background: "transparent", color: VERDE_ESCURO, fontWeight: 800, fontSize: 14, cursor: "pointer", padding: 0 },

  card: {
    background: "var(--rv-superficie)",
    border: `1px solid ${BORDA}`,
    borderRadius: 21,
    padding: "25px 27px",
    marginBottom: 18,
    boxShadow: "0 4px 18px rgba(15,23,42,0.04)",
  },
  h3: { fontFamily: FONTE_TITULO, fontSize: 18, fontWeight: 760, color: "var(--rv-tinta)", margin: "0 0 11px" },
  paragrafo: { color: "var(--rv-texto)", fontSize: 15, lineHeight: 1.68, margin: 0 },
  cardTag: {
    display: "inline-flex",
    fontSize: 10.5,
    fontWeight: 900,
    letterSpacing: "0.08em",
    color: VERDE_ESCURO,
    background: "var(--rv-azul-fundo)",
    border: "1px solid var(--rv-azul-borda)",
    borderRadius: 999,
    padding: "4px 8px",
  },
  cardFerramenta: { minHeight: 225 },
  ferramentaTopo: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  ferramentaEmoji: { fontSize: 32 },
  cardLimiteAtuacao: { border: "1px solid var(--rv-azul-borda)", background: "var(--rv-azul-fundo)" },

  avisoCanal: { margin: 0, background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", color: "var(--rv-ambar-texto)", borderRadius: 12, padding: "11px 13px", fontSize: 13, lineHeight: 1.55 },
  erroItem: { border: "1px solid var(--rv-borda-suave)", borderRadius: 12, padding: "11px 13px", background: "var(--rv-superficie)" },
  erroBadge: { fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 999 },
  erroTela: { fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)" },
  erroData: { fontSize: 11.5, color: "var(--rv-texto-fraco)", marginLeft: "auto" },
  erroDesc: { margin: 0, fontSize: 13, color: "var(--rv-texto-forte)", lineHeight: 1.5, whiteSpace: "pre-wrap" },
  tratativaTxt: { margin: "6px 0 0", fontSize: 12.5, color: "var(--rv-texto)", lineHeight: 1.5, background: "var(--rv-fundo-cartao)", borderRadius: 8, padding: "6px 10px" },
  avisoValidar: { margin: 0, background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)", color: "var(--rv-azul-texto)", borderRadius: 10, padding: "9px 12px", fontSize: 13, fontWeight: 700 },
  botaoConfirmar: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  botaoPersiste: { background: "var(--rv-superficie)", color: "var(--rv-vermelho)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  observacao: { color: "var(--rv-texto-fraco)", fontSize: 13.5, marginTop: 12 },
  lista: { margin: 0, paddingLeft: 22, color: "var(--rv-texto)", fontSize: 14.8, lineHeight: 1.85 },
  listaOrdenada: { margin: 0, paddingLeft: 22, color: "var(--rv-texto)", fontSize: 14.8, lineHeight: 1.85 },
  listaChecklist: { margin: 0, paddingLeft: 22, color: "var(--rv-texto)", fontSize: 14.5, lineHeight: 1.85 },
  listaCompacta: { margin: 0, paddingLeft: 21, color: "var(--rv-texto)", fontSize: 14.3, lineHeight: 1.75 },

  aviso: { borderRadius: 16, padding: "17px 20px", marginBottom: 22, fontSize: 14.8, lineHeight: 1.65 },
  avisoAtencao: { background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", color: "var(--rv-ambar-texto)" },
  avisoInfo: { background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)", color: "var(--rv-azul-texto)" },

  botaoPrimario: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: VERDE,
    color: "#fff",
    padding: "12px 19px",
    borderRadius: 10,
    fontWeight: 800,
    fontSize: 14.5,
    textDecoration: "none",
    border: "none",
    cursor: "pointer",
    boxShadow: "0 8px 20px rgba(15,157,107,0.18)",
  },
  botaoSecundario: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "var(--rv-superficie)",
    color: "var(--rv-texto-forte)",
    padding: "11px 17px",
    borderRadius: 10,
    fontWeight: 750,
    fontSize: 14,
    textDecoration: "none",
    border: `1px solid ${BORDA}`,
    cursor: "pointer",
  },
  botoesLinha: { display: "flex", gap: 10, flexWrap: "wrap" },
  botaoCopiar: {
    background: "var(--rv-fundo-suave)",
    color: "var(--rv-texto-forte)",
    border: `1px solid ${BORDA}`,
    borderRadius: 9,
    padding: "9px 15px",
    fontSize: 12,
    fontWeight: 750,
    cursor: "pointer",
  },

  grade4: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 18 },
  grade3: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(285px, 1fr))", gap: 18, marginBottom: 22 },
  grade2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 18, marginBottom: 22 },
  homeDuasColunas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 18, marginTop: 8 },

  cardAtalho: {
    background: "var(--rv-superficie)",
    border: `1px solid ${BORDA}`,
    borderRadius: 20,
    padding: "25px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    textAlign: "left",
    cursor: "pointer",
    boxShadow: "0 4px 16px rgba(15,23,42,0.04)",
    minHeight: 190,
  },
  cardAtalhoEmoji: { fontSize: 36 },
  cardAtalhoTitulo: { fontFamily: FONTE_TITULO, fontSize: 18, color: "var(--rv-tinta)", fontWeight: 800, lineHeight: 1.3 },
  cardAtalhoDesc: { fontSize: 14.2, color: "var(--rv-texto-suave)", lineHeight: 1.55 },
  cardAtalhoAcao: { marginTop: "auto", paddingTop: 8, fontSize: 13.5, fontWeight: 850, color: VERDE_ESCURO },
  listaAtalhosInternos: { display: "flex", flexDirection: "column", gap: 8, marginTop: 6 },
  atalhoInterno: {
    width: "100%",
    border: "1px solid var(--rv-borda-suave)",
    background: "var(--rv-fundo-suave)",
    color: "var(--rv-texto-forte)",
    borderRadius: 12,
    padding: "11px 13px",
    fontSize: 14,
    fontWeight: 750,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    cursor: "pointer",
    textAlign: "left",
  },

  numeroGrande: { fontFamily: FONTE_TITULO, fontSize: 38, fontWeight: 800, color: VERDE_ESCURO },
  labelNumero: { fontSize: 13, fontWeight: 700, color: "var(--rv-texto-fraco)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" },

  tabela: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px 12px", color: "var(--rv-texto-fraco)", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${BORDA}` },
  thNum: { textAlign: "right", padding: "10px 12px", color: "var(--rv-texto-fraco)", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${BORDA}` },
  td: { padding: "13px 14px", color: "var(--rv-texto-forte)", fontSize: 14.5, borderBottom: "1px solid var(--rv-borda-suave)" },
  tdNum: { padding: "13px 14px", color: VERDE_ESCURO, fontSize: 15, textAlign: "right", borderBottom: "1px solid var(--rv-borda-suave)" },

  labelCampo: { fontSize: 12.5, fontWeight: 700, color: "var(--rv-texto)" },
  input: { padding: "9px 12px", borderRadius: 10, border: `1px solid ${BORDA}`, fontSize: 13.5, fontFamily: "inherit" },

  cardCompetencia: { background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)" },
  competenciaTopo: { fontSize: 12, fontWeight: 800, color: "var(--rv-azul-texto)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 },
  competenciaValor: { fontFamily: FONTE_TITULO, fontSize: 22, fontWeight: 800, color: "var(--rv-tinta)", marginBottom: 6 },

  contatoUnidade: { border: "1px solid var(--rv-borda-suave)", borderRadius: 11, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 5, background: "var(--rv-superficie)" },
  linkContato: { color: VERDE_ESCURO, fontSize: 12.5, textDecoration: "none", wordBreak: "break-word" },

  cardFrase: { background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)" },
  frase: { fontFamily: FONTE_TITULO, fontSize: 14.5, color: VERDE_ESCURO, fontWeight: 700, margin: 0, lineHeight: 1.4 },

  cardHistoria: {
    background: "var(--rv-superficie)",
    border: `1px solid ${BORDA}`,
    borderRadius: 17,
    padding: "26px 16px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    color: "var(--rv-texto-forte)",
    boxShadow: "0 4px 16px rgba(15,23,42,0.04)",
  },
};
