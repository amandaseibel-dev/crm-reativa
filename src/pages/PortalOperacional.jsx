import { useState, useEffect, Fragment } from "react";
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
      { id: "script", label: "🧭 Script do Atendimento", keywords: "aluno respondeu template roteiro atendimento início apresentação dívida fechar sem interesse sem condições falta interação negociação" },
      { id: "duvidas", label: "❓ Dúvidas Frequentes", keywords: "taxa parcelamento processo template acordo mensalidade cartão boleto dúvida recorrente" },
      { id: "mensagens", label: "💬 Mensagens Prontas", keywords: "frase pronta texto whatsapp email resposta aluno copiar mensagem" },
      { id: "objecoes", label: "🔥 Quebras de Objeção", keywords: "argumentação argumento não tenho dinheiro cartão pensar desconto objeção resposta" },
    ],
  },
  {
    grupo: "Negociação",
    itens: [
      { id: "politica", label: "📄 Política de Negociação", keywords: "à vista cartão boleto acordo parcelamento entrada condição negociação regra" },
      { id: "termo", label: "✍️ Termo de Acordo", keywords: "termo assinatura gov.br adm validação validar prime acordo parcelado documento legível" },
      { id: "excecao", label: "📝 Proposta de Exceção", keywords: "proposta exceção desconto aprovação condição especial" },
      { id: "honorarios", label: "💰 Honorários e Taxas", keywords: "8% juros multa igpm taxa honorário encargos" },
      { id: "beneficios", label: "🎟️ Bolsas e Financiamentos", keywords: "bolsa fies prouni udebank educred quero bolsa credies financiamento" },
    ],
  },
  {
    grupo: "Vida Acadêmica",
    itens: [
      { id: "academico", label: "🎓 Matrícula e Rematrícula", keywords: "matrícula rematrícula webaluno trancamento antecipação consultor" },
      { id: "documentos", label: "📑 Documentos e Protocolos", keywords: "irpf imposto renda declaração contrato educacional comprovante protocolo webaluno parecer solicitação" },
      { id: "cursos", label: "📚 Cursos Ulbra", keywords: "curso graduação medicina ead presencial semipresencial faculdade" },
    ],
  },
  {
    grupo: "Operação",
    itens: [
      { id: "sistemas", label: "🚀 Sistemas e Planilhas", keywords: "reativa one crm mensageria gmail prime folya nota fiscal prestação serviços comissão pix conta planilha sistema acesso link ferramenta" },
      { id: "manualprime", label: "📘 Manual do Prime", keywords: "prime manual painel atendimento títulos receber acordos condições especiais desconto atalho financeiro" },
      { id: "ddds", label: "📞 DDDs das Unidades", keywords: "ddd código área telefone unidade cidade cachoeira canoas carazinho gravataí guaíba itumbiara manaus palmas porto alegre santa maria santarém são jerônimo torres ead" },
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
          {secao === "script" && <SecaoScript ir={navegar} />}
          {secao === "duvidas" && <SecaoDuvidas />}
          {secao === "mensagens" && <SecaoMensagens />}
          {secao === "objecoes" && <SecaoObjecoes />}
          {secao === "politica" && <SecaoPolitica />}
          {secao === "termo" && <SecaoTermoAcordo />}
          {secao === "excecao" && <SecaoExcecao />}
          {secao === "honorarios" && <SecaoHonorarios />}
          {secao === "beneficios" && <SecaoBeneficios />}
          {secao === "academico" && <SecaoAcademico />}
          {secao === "documentos" && <SecaoDocumentos />}
          {secao === "cursos" && <SecaoCursos />}
          {secao === "sistemas" && <SecaoSistemas ir={navegar} />}
          {secao === "manualprime" && <SecaoManualPrime ir={navegar} />}
          {secao === "ddds" && <SecaoDdds />}
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
      emoji: "🧭",
      titulo: "O aluno respondeu ao template",
      desc: "Siga o atendimento completo: validação, apresentação da dívida, negociação e encerramento.",
      id: "script",
      acao: "Abrir script do atendimento",
    },
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
      titulo: "É assunto de matrícula ou rematrícula",
      desc: "Veja rematrícula, antecipação, trancamento e atendimento com consultor.",
      id: "academico",
      acao: "Abrir matrícula e rematrícula",
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
            <button type="button" onClick={() => ir("script")} style={S.atalhoInterno}>Script do Atendimento <span>→</span></button>
            <button type="button" onClick={() => ir("politica")} style={S.atalhoInterno}>Política de Negociação <span>→</span></button>
            <button type="button" onClick={() => ir("objecoes")} style={S.atalhoInterno}>Quebras de Objeção <span>→</span></button>
            <button type="button" onClick={() => ir("mensagens")} style={S.atalhoInterno}>Mensagens Prontas <span>→</span></button>
            <button type="button" onClick={() => ir("documentos")} style={S.atalhoInterno}>Documentos e Protocolos <span>→</span></button>
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

/* ===================== Termo de Acordo ===================== */

function SecaoTermoAcordo() {
  const etapas = [
    {
      n: "1",
      titulo: "Negociação parcelada definida",
      texto: "Toda negociação parcelada exige Termo de Acordo. O termo deve ser enviado ao aluno para assinatura antes da conclusão do acordo."
    },
    {
      n: "2",
      titulo: "Assinatura via Gov.br",
      texto: "O aluno deve assinar o documento pelo Gov.br. Não considerar assinatura informal, imagem de assinatura ou documento sem validação adequada."
    },
    {
      n: "3",
      titulo: "Conferir legibilidade",
      texto: "O documento devolvido precisa estar completo e legível. Se houver páginas cortadas, informações ilegíveis ou arquivo incompleto, solicitar novo envio."
    },
    {
      n: "4",
      titulo: "Enviar para validação do ADM",
      texto: "O termo assinado deve ser encaminhado ao ADM para conferência e validação. Enquanto o ADM não validar, o acordo não pode ser fechado no sistema."
    },
    {
      n: "5",
      titulo: "Liberar no Prime",
      texto: "Somente após a validação do ADM o acordo pode seguir para liberação/confirmação no Prime, conforme o procedimento operacional."
    },
    {
      n: "6",
      titulo: "Comunicar o aluno",
      texto: "Após a validação e a liberação no Prime, comunicar ao aluno que o acordo foi processado e que o termo está disponível conforme o fluxo."
    }
  ];

  return (
    <>
      <TituloSecao
        emoji="✍️"
        titulo="Termo de Acordo"
        sub="Fluxo obrigatório para todas as negociações parceladas."
      />

      <Aviso>
        <strong>Regra obrigatória:</strong> nenhum acordo parcelado pode ser fechado/concluído no sistema sem
        o Termo de Acordo assinado pelo Gov.br, com documento legível e validado pelo ADM.
      </Aviso>

      <div style={S.grade2}>
        {etapas.map((etapa) => (
          <Card key={etapa.n}>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{
                width: 34,
                height: 34,
                minWidth: 34,
                borderRadius: 999,
                background: "var(--rv-azul-fundo)",
                border: "1px solid var(--rv-azul-borda)",
                color: "var(--rv-azul-texto)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 900
              }}>
                {etapa.n}
              </div>
              <div>
                <h3 style={S.h3}>{etapa.titulo}</h3>
                <p style={S.paragrafo}>{etapa.texto}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Card style={S.cardLimiteAtuacao}>
        <span style={S.cardTag}>NÃO PODE FECHAR</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>O acordo permanece pendente enquanto faltar qualquer requisito</h3>
        <ul style={S.lista}>
          <li>Termo ainda não enviado ao aluno.</li>
          <li>Termo não assinado pelo Gov.br.</li>
          <li>Documento ilegível, incompleto ou com problema de leitura.</li>
          <li>Termo ainda não validado pelo ADM.</li>
        </ul>
      </Card>

      <TituloSecao emoji="💬" titulo="Frases prontas" sub="Mensagens para usar durante o fluxo do termo." />
      <BlocoCopiar
        titulo="📄 Envio do termo para assinatura"
        texto="Olá! Para concluirmos sua negociação parcelada, é necessário assinar o Termo de Acordo pelo Gov.br. Após a assinatura, por favor nos envie o documento completo e legível para validação. O acordo somente poderá ser concluído após essa etapa."
      />
      <BlocoCopiar
        titulo="✅ Termo recebido e em validação"
        texto="Recebemos o seu Termo de Acordo assinado. O documento será validado pela nossa equipe administrativa antes da conclusão do acordo. Assim que a validação for finalizada, daremos continuidade ao procedimento e retornaremos com a confirmação."
      />
      <BlocoCopiar
        titulo="✅ Termo validado / acordo liberado"
        texto="Seu Termo de Acordo foi validado e o procedimento foi concluído conforme as condições negociadas. O termo fica disponível como registro da negociação. Em caso de dúvida, estamos à disposição."
      />
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

/* ===================== Script do Atendimento ===================== */

function SecaoScript({ ir }) {
  return (
    <>
      <TituloSecao
        emoji="🧭"
        titulo="Script do Atendimento"
        sub="Roteiro completo para quando o aluno responde ao template enviado pelo CRM de Mensageria."
      />

      <Aviso>
        <strong>Antes de responder ao aluno:</strong> a conferência no <strong>Prime é obrigatória</strong>.
        Confira também o histórico no CRM, jurídico, cancelamento, bloqueios, restrição de contato e o tipo da dívida.
        Não apresente valores ou informações financeiras antes da validação de identidade.
      </Aviso>

      <Card>
        <span style={S.cardTag}>MAPA DO ATENDIMENTO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>Siga sempre esta ordem</h3>
        <ol style={S.listaOrdenada}>
          <li><strong>Validar o caso:</strong> Prime + CRM + restrições.</li>
          <li><strong>Confirmar o aluno:</strong> nome e 3 primeiros dígitos do CPF.</li>
          <li><strong>Apresentar a dívida:</strong> tipo, período e valor correto.</li>
          <li><strong>Tentar a finalização:</strong> perguntar primeiro se podemos seguir com o pagamento hoje.</li>
          <li><strong>Somente se houver negativa:</strong> entender o motivo, apresentar a próxima alternativa e tentar o fechamento novamente.</li>
          <li><strong>Definir o resultado:</strong> fechar, sem interesse, sem condições ou falta de interação.</li>
          <li><strong>Registrar o resultado no CRM</strong> antes de finalizar o atendimento.</li>
        </ol>
      </Card>

      <TituloSecao emoji="1️⃣" titulo="Início — aluno respondeu ao template" sub="Primeiro valide a identidade; depois avance para a situação financeira." />
      <BlocoCopiar
        titulo="Validação inicial"
        texto="Olá! Obrigado pelo retorno. Para darmos continuidade com segurança, por gentileza confirme seu nome completo e os 3 primeiros dígitos do CPF."
      />
      <BlocoCopiar
        titulo="Após a validação"
        texto="Perfeito, obrigado pela confirmação. Vou te explicar a situação registrada e verificar como podemos ajudar na regularização."
      />

      <TituloSecao emoji="2️⃣" titulo="Apresentação da dívida" sub="Seja objetivo e conduza primeiro para a finalização. Só avance para alternativas se houver negativa." />
      <Card>
        <h3 style={S.h3}>Antes de apresentar</h3>
        <ul style={S.lista}>
          <li>Confirme no Prime o valor atualizado e o tipo da pendência.</li>
          <li>Se houver <strong>acordo em aberto ou vencido, priorize o acordo antes das mensalidades</strong>.</li>
          <li>Não inclua parcela de matrícula em negociação quando houver regra de bloqueio.</li>
          <li>Não faça simulação ou ofereça condição fora da política.</li>
        </ul>
      </Card>
      <BlocoCopiar
        titulo="Apresentação — mensalidades em aberto"
        texto="Identificamos parcelas em aberto referentes a [PERÍODO], com saldo atualizado de R$ [VALOR]. Podemos gerar o boleto para pagamento hoje?"
      />
      <BlocoCopiar
        titulo="Apresentação — existe acordo em aberto ou vencido"
        texto="Identificamos parcelas em aberto do seu acordo. Como existe um acordo pendente, precisamos tratar essa situação primeiro. Podemos seguir com a regularização hoje pelas formas permitidas para acordo?"
      />
      <BlocoCopiar
        titulo="Se o aluno pedir explicação do valor"
        texto="Posso explicar a origem da pendência e os encargos aplicáveis. Vou considerar as informações registradas no sistema para te orientar corretamente."
      />

      <Card style={S.cardLimiteAtuacao}>
        <span style={S.cardTag}>REGRA DE CONDUÇÃO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>Sempre tente concluir antes de avançar</h3>
        <p style={S.paragrafo}>
          A sequência do atendimento deve ser: <strong>apresentar → tentar fechar → ouvir a negativa → entender o motivo → apresentar a próxima alternativa → tentar fechar novamente</strong>.
          Não pule direto para várias opções sem antes verificar se o aluno consegue concluir na condição mais simples disponível.
        </p>
      </Card>

      <TituloSecao emoji="3️⃣" titulo="Negativa — entenda o motivo e avance para a próxima alternativa" sub="A conversa só avança para outras condições quando o aluno disser que não consegue concluir na primeira opção." />
      <BlocoCopiar
        titulo="Aluno aceita pagar hoje"
        texto="Perfeito. Vou seguir com a condição para concluirmos o pagamento hoje."
      />
      <BlocoCopiar
        titulo="Aluno diz que não consegue pagar hoje"
        texto="Entendo. Posso saber o que impede o pagamento hoje: o valor, a forma de pagamento, a entrada, a quantidade de parcelas ou outro motivo?"
      />
      <BlocoCopiar
        titulo="Depois de apresentar uma alternativa"
        texto="Com essa condição, conseguimos seguir com a regularização hoje?"
      />

      <div style={S.botoesLinha}>
        <BotaoSecundario onClick={() => ir("politica")}>📄 Consultar Política de Negociação</BotaoSecundario>
        <BotaoSecundario onClick={() => ir("objecoes")}>🔥 Consultar Quebras de Objeção</BotaoSecundario>
        <BotaoSecundario onClick={() => ir("honorarios")}>💰 Honorários e Taxas</BotaoSecundario>
      </div>

      <TituloSecao emoji="✅" titulo="Rota 1 — Vamos fechar" sub="Quando o aluno aceita avançar com uma condição permitida." />
      <Card>
        <h3 style={S.h3}>Fluxo do fechamento</h3>
        <ol style={S.listaOrdenada}>
          <li>Confirme a condição conforme a Política de Negociação.</li>
          <li>Repita ao aluno forma de pagamento, entrada, parcelas e vencimentos antes de concluir.</li>
          <li>Se a negociação for parcelada, envie o Termo de Acordo para assinatura pelo Gov.br.</li>
          <li>Receba o termo completo e legível e encaminhe para validação do ADM.</li>
          <li>Somente após a validação do ADM, libere/conclua o acordo no Prime conforme o fluxo.</li>
          <li>Quando houver pagamento por cartão, o comprovante deve ser anexado no CRM para a baixa.</li>
          <li>Registre no CRM tudo o que foi negociado e combinado.</li>
        </ol>
      </Card>
      <BlocoCopiar
        titulo="Confirmar a condição antes de concluir"
        texto="Perfeito. A condição ficou da seguinte forma: [FORMA DE PAGAMENTO / ENTRADA / PARCELAS / VENCIMENTOS]. Está de acordo para seguirmos com essa condição?"
      />
      <BlocoCopiar
        titulo="Negociação parcelada — envio do termo"
        texto="Para concluirmos a negociação parcelada, vou encaminhar o Termo de Acordo. Ele deve ser assinado pelo Gov.br e devolvido completo e legível. Após o recebimento, o documento passa pela validação do nosso Administrativo antes da conclusão do acordo."
      />
      <BlocoCopiar
        titulo="Fechamento concluído"
        texto="Seu acordo foi registrado conforme as condições negociadas. Fique atento aos vencimentos para manter o acordo em dia. Se precisar de alguma orientação, seguimos à disposição."
      />
      <Aviso tom="info">
        <strong>Rematrícula:</strong> em novo acordo formalizado e regular, o benefício vigente permite a rematrícula
        após a confirmação do pagamento da entrada. Isso não se aplica a acordo quebrado ou com parcelas vencidas.
      </Aviso>

      <TituloSecao emoji="🚫" titulo="Rota 2 — Sem interesse" sub="Não encerre na primeira negativa. Primeiro tente entender o motivo." />
      <BlocoCopiar
        titulo="Primeira resposta — entender a negativa"
        texto="Entendo. Posso saber qual é o principal motivo para você não ter interesse em negociar neste momento? É uma questão de valor, forma de pagamento, momento financeiro ou existe outro ponto?"
      />
      <BlocoCopiar
        titulo="Tentar manter o diálogo"
        texto="Obrigado por me explicar. Dependendo desse ponto, podemos verificar uma alternativa prevista. Se encontrarmos uma condição que resolva esse impedimento, conseguimos seguir com a regularização hoje?"
      />
      <BlocoCopiar
        titulo="Aluno mantém que não tem interesse"
        texto="Entendo. Vou registrar que, neste momento, você optou por não seguir com a negociação. Caso queira retomar e verificar as condições disponíveis em outro momento, seguimos à disposição."
      />
      <Card>
        <h3 style={S.h3}>O que registrar</h3>
        <ul style={S.listaCompacta}>
          <li>Motivo informado pelo aluno.</li>
          <li>Se foi apresentada alguma alternativa.</li>
          <li>Que o aluno manteve a decisão de não negociar.</li>
          <li>Retorno combinado, somente se houver uma data definida com o aluno.</li>
        </ul>
      </Card>

      <TituloSecao emoji="💬" titulo="Rota 3 — Sem condições de pagamento" sub="Descubra o impedimento e tente uma saída permitida antes de encerrar." />
      <BlocoCopiar
        titulo="Entender a dificuldade"
        texto="Entendo. O que hoje impede o pagamento: o valor total, a entrada, a quantidade de parcelas, a forma de pagamento ou o momento financeiro? Se eu entender melhor, consigo verificar o que pode ser feito dentro das condições disponíveis."
      />
      <Card>
        <h3 style={S.h3}>Se for acordo em aberto/vencido</h3>
        <ul style={S.lista}>
          <li>Não reparcelar o acordo em boleto.</li>
          <li>Regularização do acordo: à vista ou cartão, conforme a política vigente.</li>
          <li>Sem condição de quitar todo o saldo, oferecer o pagamento das parcelas individualmente, uma a uma.</li>
          <li>Enquanto houver parcelas vencidas do acordo, a matrícula permanece bloqueada.</li>
        </ul>
      </Card>
      <Card>
        <h3 style={S.h3}>Se forem mensalidades</h3>
        <ul style={S.lista}>
          <li>Consulte a Política de Negociação e apresente somente condições permitidas.</li>
          <li>Se a necessidade ultrapassar a política, não prometa: encaminhe para análise de exceção quando aplicável.</li>
          <li>Se houver desconto condicional perdido por atraso, o cálculo deve ser solicitado à supervisão; o operador não informa valores por conta própria.</li>
        </ul>
      </Card>
      <BlocoCopiar
        titulo="Após encontrar uma condição possível"
        texto="Com essa condição, conseguimos seguir com o pagamento e concluir a regularização hoje?"
      />
      <BlocoCopiar
        titulo="Ainda sem condição após as alternativas"
        texto="Entendo. Neste momento você me informa que realmente não consegue assumir nenhuma das condições disponíveis. Existe alguma data em que faça sentido retomarmos esse contato para verificar novamente sua situação?"
      />
      <BlocoCopiar
        titulo="Sem previsão de pagamento"
        texto="Certo. Vou registrar que, neste momento, você não possui condição de pagamento e não tem uma previsão definida. Caso sua situação mude, podemos verificar novamente as condições disponíveis."
      />

      <TituloSecao emoji="⏳" titulo="Rota 4 — Falta de interação" sub="Quando o aluno respondeu inicialmente, mas deixou de interagir durante o atendimento." />
      <BlocoCopiar
        titulo="Retomar a conversa"
        texto="Olá! Ainda está por aqui? Se desejar, podemos continuar o atendimento e verificar sua situação."
      />
      <BlocoCopiar
        titulo="Última mensagem antes do encerramento"
        texto="Olá! Como não tivemos continuidade no atendimento, este contato será encerrado. Quando desejar retomar, basta enviar uma nova mensagem para continuarmos de onde paramos."
      />
      <Card>
        <h3 style={S.h3}>Antes de encerrar por falta de interação</h3>
        <ul style={S.listaCompacta}>
          <li>Registre no CRM que o aluno respondeu inicialmente, mas não deu continuidade.</li>
          <li>Registre as mensagens e orientações já apresentadas.</li>
          <li>Não registre como “sem interesse” se o aluno simplesmente parou de responder.</li>
          <li>Se houver retorno combinado, agende-o corretamente.</li>
        </ul>
      </Card>

      <TituloSecao emoji="📌" titulo="Resultado final do atendimento" sub="O registro precisa deixar claro o que aconteceu para o próximo operador." />
      <div style={S.grade2}>
        <Card>
          <span style={S.cardTag}>FECHADO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Negociação concluída</h3>
          <p style={S.paragrafo}>Registrar condição, forma de pagamento, vencimentos, termo, comprovantes e próximos passos.</p>
        </Card>
        <Card>
          <span style={S.cardTag}>SEM INTERESSE</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno recusou negociar</h3>
          <p style={S.paragrafo}>Registrar o motivo real informado e as alternativas apresentadas.</p>
        </Card>
        <Card>
          <span style={S.cardTag}>SEM CONDIÇÕES</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno quer, mas não consegue pagar</h3>
          <p style={S.paragrafo}>Registrar a dificuldade, alternativas verificadas e eventual data de retorno.</p>
        </Card>
        <Card>
          <span style={S.cardTag}>SEM INTERAÇÃO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno parou de responder</h3>
          <p style={S.paragrafo}>Registrar a interrupção sem confundir com recusa de negociação.</p>
        </Card>
      </div>

      <Aviso tom="info">
        <strong>Regra de qualidade:</strong> todo ponto do atendimento deve buscar a finalização do caso antes de avançar.
        Primeiro tente concluir o pagamento; diante da negativa, entenda o motivo, apresente a próxima alternativa permitida
        e tente o fechamento novamente. O atendimento não deve terminar apenas com “não”, “depois” ou “não consigo” sem explorar
        de forma respeitosa uma possibilidade real de solução.
      </Aviso>
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
      <BlocoCopiar titulo="📑 Parcelas em aberto" texto="Você pode consultar suas parcelas em aberto diretamente pelo WebAluno, em Posição Financeira. Caso precise de um documento mais detalhado ou emitido pela instituição, a solicitação deve ser realizada por meio de protocolo no próprio WebAluno." />
      <BlocoCopiar titulo="⏳ Aguardando comprovante" texto="Olá! Ainda estamos aguardando o envio do comprovante de pagamento para dar sequência à baixa. Assim que possível, encaminhe para concluirmos o procedimento." />
      <BlocoCopiar titulo="📄 Aguardando termo" texto="Olá! Para concluirmos sua negociação parcelada, precisamos receber o Termo de Acordo assinado pelo Gov.br, completo e legível. Assim que recebermos o documento, ele seguirá para validação do ADM antes da conclusão do acordo." />
      <BlocoCopiar titulo="✅ Termo recebido / aguardando validação do ADM" texto="Recebemos o seu Termo de Acordo assinado. O documento está em validação com a equipe administrativa. O acordo somente será concluído após essa validação e a liberação no Prime." />
      <BlocoCopiar titulo="🔗 Link de pagamento enviado" texto="Olá! Encaminhamos o link de pagamento referente ao seu acordo. Qualquer dificuldade para acessar ou concluir o pagamento, é só nos avisar." />
      <BlocoCopiar titulo="✅ Acordo fechado" texto="Olá! Seu acordo foi registrado com sucesso. Fique atento às datas de vencimento das parcelas para manter tudo em dia." />
      <BlocoCopiar titulo="🔁 Retomando contato" texto="Olá! Estamos retomando o contato sobre a sua pendência. Vamos verificar a melhor forma de regularizar a situação." />
      <BlocoCopiar
        titulo="📆 Vou pagar no final do semestre"
        texto="Entendo. Posso saber por qual motivo você prefere deixar o pagamento para o final do semestre? Dependendo da sua situação, podemos verificar se existe alguma alternativa para ajudar você a regularizar ou encaminhar isso hoje."
      />
      <BlocoCopiar
        titulo="💬 Não tenho interesse em negociar"
        texto="Entendo. Posso saber qual é o principal motivo que hoje impede o pagamento ou uma negociação? Se você me explicar a situação, podemos verificar se existe alguma possibilidade dentro das condições disponíveis que ajude a resolver isso hoje."
      />
      <BlocoCopiar
        titulo="🎟️ Desconto condicional perdido por atraso"
        texto="Entendo. Esse desconto é condicionado ao pagamento das parcelas em dia. Para esta regularização, podemos solicitar à supervisão o cálculo com o restabelecimento do benefício. Se essa condição for possível, ela ajudaria você a colocar os valores em dia? Após a regularização, é importante manter as próximas parcelas em dia, pois o desconto não poderá ser restabelecido novamente em caso de novo atraso."
      />
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
        titulo="🎓 Rematrícula — WebAluno ou consultor"
        texto="Você pode realizar sua rematrícula diretamente pelo WebAluno. Se preferir, também podemos encaminhar sua solicitação para atendimento com um dos nossos consultores. Deseja realizar a rematrícula pelo WebAluno ou prefere o auxílio de um consultor?"
      />
      <BlocoCopiar
        titulo="🎓 Rematrícula após pagamento da entrada do acordo"
        texto="Como benefício vigente da Ulbra, após a confirmação do pagamento da entrada do seu acordo e a conclusão do procedimento de formalização, você poderá realizar sua rematrícula sem precisar aguardar a quitação total do acordo. Depois dessa etapa, você poderá seguir pelo WebAluno ou, se preferir, podemos encaminhar seu atendimento para um de nossos consultores."
      />
      <BlocoCopiar
        titulo="📆 Rematrícula antecipada"
        texto="Como sua rematrícula foi realizada de forma antecipada, o valor correspondente ao semestre foi distribuído em um número maior de parcelas. Não se preocupe: o valor total do semestre permanece o mesmo. O que mudou foi apenas a quantidade de parcelas, permitindo que o pagamento do semestre seja diluído por um período maior."
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
      pergunta: "Vou pagar no final do semestre",
      principal: "Entendo. Posso saber por qual motivo você prefere deixar o pagamento para o final do semestre?",
      alternativa: "Dependendo da sua situação, podemos verificar se existe alguma alternativa para ajudar você a regularizar ou encaminhar isso hoje.",
      objetivo: "Entender o motivo real do adiamento e manter o diálogo aberto.",
      atencao: "Não encerrar a conversa apenas aceitando o adiamento. Fazer perguntas abertas, sem pressionar."
    },
    {
      pergunta: "Não tenho interesse em negociar",
      principal: "Entendo. Posso saber qual é o principal motivo que hoje impede o pagamento ou uma negociação?",
      alternativa: "Existe algum ponto específico, como valor, forma de pagamento ou momento financeiro, que esteja dificultando? Podemos verificar se há algo que ajude a resolver sua situação hoje.",
      objetivo: "Identificar a objeção real e verificar se existe uma alternativa aplicável.",
      atencao: "Manter tom respeitoso e aberto. Se o aluno não quiser continuar a conversa, não pressionar."
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
      principal: "Esse percentual corresponde aos honorários de cobrança previstos no Contrato de Prestação de Serviços para débitos acima de 30 dias.",
      objetivo: "Informar de forma objetiva a origem dos honorários, sem gerar uma tratativa adicional desnecessária.",
      atencao: "Não chamar de taxa bancária, taxa da operadora ou taxa do estabelecimento. A previsão dos honorários consta no contrato de prestação de serviços."
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
    { p: "Comprovante de cartão deve ir onde?", r: "Sempre no CRM. O comprovante de pagamento no cartão deve ser anexado e registrado no CRM para que a baixa seja realizada corretamente." },
    { p: "Como funciona o Termo de Acordo nas negociações parceladas?", r: "O Termo de Acordo é obrigatório em toda negociação parcelada. O aluno deve assinar pelo Gov.br e devolver o documento completo e legível. O termo deve ser validado pelo ADM antes de qualquer fechamento no sistema. Somente após a validação do ADM o acordo pode ser liberado no Prime e concluído. Não fechar nenhum acordo parcelado sem o termo assinado, legível e validado." },
    { p: "Por que existe 1% de parcelamento se no link aparece “sem taxa de parcelamento”?", r: "Nas negociações parceladas, o sistema aplica 1% de encargo de parcelamento por parcela, conforme a condição da negociação. Quando o link informa “sem taxa de parcelamento”, significa que o próprio link não acrescentará uma nova taxa sobre o valor já negociado. Não informar que esse percentual é taxa do banco, da operadora ou do estabelecimento." },
    { p: "Qual a prioridade de negociação: mensalidades ou acordos?", r: "Sempre priorizar os acordos. Se houver acordo em aberto ou vencido, trate o acordo antes das mensalidades." },
    { p: "Como negociar um acordo em aberto ou vencido?", r: "Primeiro consulte a Política de Negociação. Acordos não podem ser reparcelados em boleto: a regularização deve ser à vista ou no cartão de crédito. Se o aluno não tiver condição de quitar o saldo nessas modalidades, ofereça o pagamento das parcelas individualmente, uma a uma. Enquanto houver parcelas vencidas, a matrícula não será liberada." },
    { p: "Posso realizar a rematrícula pagando somente a entrada do acordo?", r: "Sim, quando se tratar de um novo acordo formalizado e regular. Como benefício operacional vigente da Ulbra, a rematrícula pode ser realizada após a confirmação do pagamento da entrada, sem necessidade de aguardar a quitação integral. Essa regra não se aplica a acordo quebrado ou com parcelas vencidas, que precisa ser regularizado." },
    { p: "Por quanto tempo um aluno fica fidelizado ao operador?", r: "A fidelização é de 10 dias. Durante esse período, o operador é responsável pela continuidade do atendimento. Após os 10 dias, o aluno volta a ficar disponível para ações massivas e atendimento receptivo. Em faltas, ausências ou mudanças de horário sem agendamento prévio, os casos pendentes podem ser redistribuídos via CRM para outros colegas concluírem; nesses casos, a prioridade é não deixar o aluno sem retorno e a fidelização do operador anterior não deve impedir a continuidade." },
    { p: "Quando acontece o giro de carteira?", r: "O giro de carteira acontece sempre após a inclusão de novas remessas de parcelas e/ou novos alunos. A ReATIVA recebe para cobrança parcelas que já atingiram 31 dias de atraso na contagem operacional, sem contabilizar sábados e domingos. Após a entrada da nova remessa, a carteira é atualizada para redistribuição e continuidade das ações conforme as regras vigentes." },
    { p: "O aluno perdeu um desconto condicional por atraso e diz que não sabia que precisava pagar em dia. O que fazer?", r: "Quando o desconto for condicionado ao pagamento em dia, podemos avaliar o restabelecimento do benefício para a regularização atual. O operador não deve informar valores nem fazer o cálculo diretamente: encaminhe o caso à supervisão para cálculo da condição. Depois, confirme com o aluno se essa possibilidade ajudaria a colocar os valores em dia. Após a regularização, reforce que o desconto não será restabelecido novamente em caso de novo atraso e que as próximas parcelas precisam ser mantidas em dia para preservar o benefício." },
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
      <TituloSecao
        emoji="💰"
        titulo="Honorários e Taxas"
        sub="Entenda a ordem correta do cálculo e como os honorários acompanham a negociação."
      />

      <div style={S.grade3}>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>8%</div>
          <div style={S.labelNumero}>Honorários</div>
          <p style={S.paragrafo}>Aplicados sobre a base atualizada do débito, após juros, multa e IGPM.</p>
        </Card>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>1% a.m.</div>
          <div style={S.labelNumero}>Juros</div>
          <p style={S.paragrafo}>Conforme regra vigente.</p>
        </Card>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>2%</div>
          <div style={S.labelNumero}>Multa</div>
          <p style={S.paragrafo}>Conforme regra vigente.</p>
        </Card>
        <Card style={{ textAlign: "center" }}>
          <div style={S.numeroGrande}>IGPM</div>
          <div style={S.labelNumero}>Correção monetária</div>
          <p style={S.paragrafo}>Aplicado conforme regra vigente do contrato.</p>
        </Card>
      </div>

      <Card>
        <span style={S.cardTag}>ORDEM DO CÁLCULO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>Como calcular os 8% de honorários</h3>
        <ol style={S.listaOrdenada}>
          <li>Comece pelo <strong>valor principal</strong>.</li>
          <li>Some os <strong>juros</strong>.</li>
          <li>Some a <strong>multa</strong>.</li>
          <li>Some a <strong>correção pelo IGPM</strong>.</li>
          <li>O resultado será a <strong>base atualizada do débito</strong>.</li>
          <li>Somente depois aplique <strong>8% de honorários</strong> sobre essa base.</li>
          <li>Some os honorários à base atualizada para chegar ao <strong>valor total da negociação</strong>.</li>
        </ol>
      </Card>

      <Card style={S.cardLimiteAtuacao}>
        <span style={S.cardTag}>ATENÇÃO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>Não aplique 8% sobre o valor já fechado</h3>
        <p style={S.paragrafo}>
          Se o valor consultado já estiver com os honorários incluídos, não aplique 8% novamente.
          O percentual deve ser calculado sobre a base formada por <strong>principal + juros + multa + IGPM</strong>.
          Aplicar 8% sobre um valor que já contém os honorários gera um valor incorreto.
        </p>
      </Card>

      <Card>
        <span style={S.cardTag}>PARCELAMENTO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>Como os honorários são distribuídos no acordo</h3>
        <p style={S.paragrafo}>
          Os honorários são calculados antes do parcelamento e depois acompanham a mesma proporção do acordo.
        </p>
        <ul style={{ ...S.lista, marginTop: 12 }}>
          <li>
            <strong>Exemplo de condição: 30% de entrada + 6x.</strong>
          </li>
          <li>
            A entrada de 30% deve carregar também <strong>30% do valor dos honorários</strong>.
          </li>
          <li>
            O saldo restante dos honorários acompanha o saldo restante da negociação e é diluído nas <strong>6 parcelas</strong>.
          </li>
          <li>
            Não separar os honorários do fluxo do acordo: eles acompanham proporcionalmente entrada e parcelas.
          </li>
        </ul>
      </Card>

      <Aviso tom="info">
        <strong>Resumo:</strong> principal + juros + multa + IGPM = base atualizada. Sobre essa base, calcular 8% de honorários.
        Depois, se houver parcelamento, distribuir os honorários na mesma proporção da entrada e das parcelas do acordo.
      </Aviso>
    </>
  );
}

/* ===================== Meta de Honorários ===================== */

const moedaBR = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function SecaoMeta() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const agora = new Date();
  const mesAtual = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}`;

  useEffect(() => {
    let vivo = true;
    supabase.rpc("projecao_snapshot_ler", { p_mes: mesAtual }).then(({ data, error }) => {
      if (!vivo) return;
      setCarregando(false);
      if (error) {
        setErro("Não foi possível carregar a meta do mês.");
        return;
      }
      setDados(data?.dados || null);
    });
    return () => { vivo = false; };
  }, [mesAtual]);

  if (carregando) return <Carregando texto="Carregando a meta do mês…" />;

  const honorario = Number(
    dados?.honorario_mes_filial ??
    dados?.honorario_mes ??
    0
  );

  const percentual = Number(
    dados?.percentual_meta_filial ??
    dados?.percentual_meta_individual_realizado ??
    dados?.percentual_meta ??
    0
  );

  return (
    <>
      <TituloSecao emoji="🎯" titulo="Meta do mês" />

      {erro ? <Card><p style={S.paragrafo}>{erro}</p></Card> : null}

      {!erro ? (
        <Card>
          <h3 style={S.h3}>Honorário {mesAtual}</h3>
          <p style={{ ...S.paragrafo, fontSize: 30, fontWeight: 800, color: "var(--rv-tinta)", margin: "8px 0 4px" }}>
            {moedaBR(honorario)}
          </p>
          <p style={{ ...S.paragrafo, fontWeight: 800, margin: 0 }}>
            {percentual.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}% da meta
          </p>
        </Card>
      ) : null}
    </>
  );
}

/* ===================== LGPD e Conduta ===================== */

function SecaoLgpd() {
  return (
    <>
      <TituloSecao
        emoji="🔐"
        titulo="LGPD e Conduta"
        sub="Procedimentos obrigatórios para proteger os dados do aluno, a operação e a instituição."
      />

      <Aviso tom="info">
        <strong>Por que este procedimento é necessário?</strong><br />
        A validação de identidade e os cuidados com os dados não são apenas uma formalidade.
        Eles existem para garantir que informações financeiras e acadêmicas sejam tratadas somente com a pessoa correta,
        reduzir o risco de exposição indevida, evitar erros de identificação e fraude, proteger o aluno e a instituição
        e manter rastreabilidade sobre o que foi informado durante o atendimento.
      </Aviso>

      <Card>
        <h3 style={S.h3}>O que esse cuidado evita</h3>
        <ul style={S.lista}>
          <li>Envio de valores, boletos, contratos ou dados acadêmicos para a pessoa errada.</li>
          <li>Exposição de informações financeiras a familiares, terceiros ou contatos não autorizados.</li>
          <li>Fraudes ou tratativas realizadas com alguém que não seja o titular.</li>
          <li>Retrabalho causado por identificação incorreta do aluno.</li>
          <li>Riscos operacionais, reputacionais e de descumprimento das regras de proteção de dados.</li>
        </ul>
      </Card>

      <Card>
        <h3 style={S.h3}>Confirmação e proteção de dados</h3>
        <ul style={S.lista}>
          <li>Confirmar os 3 primeiros dígitos do CPF antes de tratar informações financeiras ou acadêmicas.</li>
          <li>Somente após a validação iniciar a tratativa de valores, acordos, boletos, contratos ou dados acadêmicos.</li>
          <li>Não compartilhar dados do aluno fora dos canais autorizados.</li>
          <li>Não expor CPF completo desnecessariamente.</li>
          <li>Não usar número pessoal para atendimento.</li>
        </ul>
      </Card>

      <Card>
        <h3 style={S.h3}>Atendimento a terceiros</h3>
        <p style={S.paragrafo}>
          Informações devem ser tratadas diretamente com o titular. Não informar a terceiros valores, boletos,
          contratos, dados acadêmicos, acordos, telefones, e-mails cadastrados ou outras informações financeiras.
        </p>
        <p style={{ ...S.paragrafo, marginTop: 12 }}>
          <strong>Resposta de apoio:</strong> “Por questões de segurança e proteção de dados, as informações podem ser tratadas apenas diretamente com o titular.”
        </p>
      </Card>

      <Card>
        <h3 style={S.h3}>Segurança da informação</h3>
        <ul style={S.lista}>
          <li>Não compartilhar acessos internos.</li>
          <li>Não salvar dados em aparelhos pessoais.</li>
          <li>Não enviar dados em grupos.</li>
          <li>Conferir o destinatário antes de enviar documentos.</li>
          <li>Bloquear a tela ao se afastar.</li>
        </ul>
      </Card>

      <Card>
        <h3 style={S.h3}>Conduta no acionamento</h3>
        <ul style={S.lista}>
          <li>Verificar histórico antes de acionar.</li>
          <li>Não acionar casos com jurídico, cancelamento ou bloqueio.</li>
          <li>Registrar a tratativa no CRM para manter histórico e rastreabilidade.</li>
          <li>Não prometer condições sem aprovação.</li>
          <li>Não utilizar linguagem agressiva ou constrangedora.</li>
        </ul>
      </Card>

      <Card style={S.cardLimiteAtuacao}>
        <span style={S.cardTag}>LEMBRETE</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>Proteção de dados também é parte da qualidade do atendimento</h3>
        <p style={S.paragrafo}>
          Um atendimento correto precisa ser seguro, identificável e registrado. Em caso de dúvida sobre a identidade
          do aluno ou sobre o que pode ser informado, não avance com a tratativa até confirmar o procedimento adequado.
        </p>
      </Card>
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
      titulo: "Acordos, termos e honorários",
      itens: [
        "Toda negociação parcelada exige Termo de Acordo assinado pelo Gov.br, legível e validado pelo ADM.",
        "Não fechar/concluir acordo parcelado no sistema antes da validação do termo pelo ADM.",
        "Após a validação do ADM, liberar o acordo no Prime e comunicar o aluno conforme o fluxo.",
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
    {
      titulo: "Fidelização e continuidade do atendimento",
      itens: [
        "O operador mantém a responsabilidade pelo aluno durante 10 dias de fidelização.",
        "Após os 10 dias, o aluno fica disponível novamente para ações massivas e para atendimento receptivo.",
        "A fidelização não pode impedir a continuidade do atendimento nem deixar o aluno sem retorno.",
        "Em caso de falta, ausência ou mudança de horário sem agendamento prévio, os atendimentos pendentes podem ser enviados pelo CRM para outros colegas concluírem.",
        "Nos casos redistribuídos por ausência ou mudança de horário, não haverá fidelização para o operador anterior: a prioridade é concluir o atendimento do aluno.",
        "Se houver retorno previamente agendado e devidamente registrado, respeitar o agendamento conforme o fluxo operacional.",
        "Premissa da operação: nenhum aluno deve ficar sem atendimento ou sem retorno por causa da titularidade do caso.",
      ],
    },
    {
      titulo: "Giro de carteira e novas remessas",
      itens: [
        "O giro de carteira acontece sempre após a inclusão de novas remessas de parcelas e/ou novos alunos.",
        "A operação recebe para cobrança somente parcelas que já atingiram 31 dias de atraso na contagem operacional.",
        "Na contagem desses 31 dias, sábados e domingos não são contabilizados.",
        "Após a entrada da nova remessa, a carteira é atualizada para redistribuição e continuidade das ações conforme as regras vigentes.",
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
        <br /><strong>Premissa de atendimento:</strong> a fidelização organiza a responsabilidade do operador, mas nunca pode deixar um aluno sem retorno ou sem continuidade.
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
        titulo="Matrícula e Rematrícula"
        sub="Orientações para rematrícula, antecipação e trancamento. Documentos e protocolos possuem uma seção própria no menu."
      />

      <div style={S.grade2}>
        <Card>
          <span style={S.cardTag}>REMATRÍCULA</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno deseja realizar a rematrícula</h3>
          <p style={S.paragrafo}>
            Se não houver pendências impeditivas, o aluno pode realizar a rematrícula diretamente pelo WebAluno ou
            solicitar auxílio de um consultor.
          </p>
          <p style={{ ...S.paragrafo, marginTop: 10 }}>
            <strong>Quando houver um novo acordo:</strong> como benefício operacional vigente da Ulbra, a rematrícula
            pode ser realizada após a confirmação do pagamento da entrada do acordo, sem necessidade de aguardar a
            quitação integral. O acordo deve estar formalizado conforme o fluxo vigente antes da liberação.
          </p>
          <p style={{ ...S.paragrafo, marginTop: 10 }}>
            Se precisar de atendimento ou auxílio, direcione o caso para a coluna <strong>Rematrícula</strong> no Kanban.
          </p>
        </Card>

        <Card style={S.cardLimiteAtuacao}>
          <span style={S.cardTag}>IMPORTANTE</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Entrada do acordo × acordo vencido</h3>
          <p style={S.paragrafo}>
            O benefício da rematrícula após o pagamento da entrada se aplica ao novo acordo formalizado e regular.
            Se já houver parcelas vencidas de um acordo anterior ou acordo quebrado, permanece a regra de bloqueio
            até a regularização da pendência.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>ANTECIPAÇÃO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Rematrícula antecipada</h3>
          <p style={S.paragrafo}>
            Quando a rematrícula é realizada antecipadamente, o valor total do semestre pode ser distribuído em um
            número maior de parcelas. O valor final do semestre permanece o mesmo; muda apenas a quantidade de parcelas.
          </p>
          <p style={{ ...S.paragrafo, marginTop: 10 }}>
            Se o aluno alegar antecipação, verifique em <strong>Títulos a Receber</strong> se consta um valor pago
            em uma única parcela, exibido em azul. Depois encaminhe ao ADM para redirecionamento à unidade quando necessário.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>TRANCAMENTO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Existe trancamento retroativo?</h3>
          <p style={S.paragrafo}>
            Não. O trancamento possui prazo máximo conforme o calendário acadêmico. Se o cancelamento ou
            trancamento ocorrer após o vencimento de uma parcela, essa parcela é considerada devida.
            Oriente sempre o aluno a verificar o parecer do protocolo realizado no WebAluno.
          </p>
        </Card>

        <Card style={S.cardLimiteAtuacao}>
          <span style={S.cardTag}>LIMITE DE ATUAÇÃO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Questões acadêmicas devem seguir para a área responsável</h3>
          <p style={S.paragrafo}>
            A ReATIVA orienta sobre a parte financeira. Decisões acadêmicas, pareceres, deferimentos e procedimentos
            de matrícula/rematrícula são tratados pelas áreas responsáveis da Ulbra.
          </p>
        </Card>
      </div>

      <TituloSecao emoji="💬" titulo="Frases prontas" sub="Modelos para usar no atendimento." />
      <BlocoCopiar
        titulo="Rematrícula — WebAluno ou consultor"
        texto="Você pode realizar sua rematrícula diretamente pelo WebAluno. Se preferir, também podemos encaminhar sua solicitação para atendimento com um dos nossos consultores. Deseja realizar a rematrícula pelo WebAluno ou prefere o auxílio de um consultor?"
      />
      <BlocoCopiar
        titulo="Rematrícula após pagamento da entrada do acordo"
        texto="Como benefício vigente da Ulbra, após a confirmação do pagamento da entrada do seu acordo e a conclusão do procedimento de formalização, você poderá realizar sua rematrícula sem precisar aguardar a quitação total do acordo. Depois dessa etapa, você poderá seguir pelo WebAluno ou, se preferir, podemos encaminhar seu atendimento para um de nossos consultores."
      />
      <BlocoCopiar
        titulo="Rematrícula antecipada"
        texto="Como sua rematrícula foi realizada de forma antecipada, o valor correspondente ao semestre foi distribuído em um número maior de parcelas. Não se preocupe: o valor total do semestre permanece o mesmo. O que mudou foi apenas a quantidade de parcelas, permitindo que o pagamento do semestre seja diluído por um período maior."
      />
    </>
  );
}

/* ===================== Documentos e Protocolos ===================== */

function SecaoDocumentos() {
  return (
    <>
      <TituloSecao
        emoji="📑"
        titulo="Documentos e Protocolos"
        sub="Onde localizar documentos no WebAluno e como orientar o aluno em solicitações e protocolos."
      />

      <div style={S.grade2}>
        <Card>
          <span style={S.cardTag}>IMPOSTO DE RENDA</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Declaração de IRPF</h3>
          <p style={S.paragrafo}>
            No WebAluno, acessar <strong>Posição Financeira → Declaração IRPF → selecionar o Ano-base correspondente</strong>.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>CONTRATO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Contrato Educacional</h3>
          <p style={S.paragrafo}>
            No WebAluno, acessar <strong>Posição Financeira → Contrato Educacional</strong>.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>PARCELAS EM ABERTO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Aluno solicita documento das parcelas em aberto</h3>
          <p style={S.paragrafo}>
            Primeiro, oriente o aluno a consultar diretamente no <strong>WebAluno → Posição Financeira</strong>,
            onde poderá visualizar as parcelas em aberto. Se precisar de um documento mais detalhado ou emitido
            pela instituição, a solicitação deve ser realizada por meio de <strong>protocolo no WebAluno</strong>.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>COMPROVANTE</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Comprovante de pagamento</h3>
          <p style={S.paragrafo}>
            O boleto pago pode ser utilizado como comprovante. Para pagamento via Pix, utilizar o comprovante do Pix.
            Caso o aluno precise de um documento emitido pela instituição, orientar a abertura de protocolo no WebAluno.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>PROTOCOLOS</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Acompanhamento e parecer</h3>
          <p style={S.paragrafo}>
            Sempre orientar o aluno a acompanhar no WebAluno o andamento e o <strong>parecer</strong> dos protocolos realizados.
            A abertura do protocolo não significa aprovação da solicitação.
          </p>
        </Card>

        <Card>
          <span style={S.cardTag}>TRANCAMENTO / CANCELAMENTO</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Solicitações acadêmicas</h3>
          <p style={S.paragrafo}>
            Para pedidos de trancamento, cancelamento ou outras solicitações acadêmicas, orientar o aluno a seguir o
            procedimento institucional e acompanhar o parecer do protocolo. O operador não deve antecipar o resultado.
          </p>
        </Card>
      </div>

      <TituloSecao emoji="💬" titulo="Frases prontas" sub="Respostas rápidas para documentos e protocolos." />
      <BlocoCopiar
        titulo="Declaração de Imposto de Renda"
        texto="Você pode acessar sua Declaração de IRPF diretamente pelo WebAluno. Entre em Posição Financeira, selecione Declaração IRPF e escolha o ano-base desejado."
      />
      <BlocoCopiar
        titulo="Contrato Educacional"
        texto="O seu Contrato Educacional pode ser consultado pelo WebAluno, em Posição Financeira → Contrato Educacional."
      />
      <BlocoCopiar
        titulo="Parcelas em aberto"
        texto="Você pode consultar suas parcelas em aberto diretamente pelo WebAluno, em Posição Financeira. Caso precise de um documento mais detalhado ou emitido pela instituição, a solicitação deve ser realizada por meio de protocolo no próprio WebAluno."
      />
      <BlocoCopiar
        titulo="Acompanhar protocolo"
        texto="Orientamos que acompanhe o andamento da sua solicitação diretamente pelo WebAluno e verifique o parecer do protocolo. A abertura do protocolo não significa aprovação automática; é necessário aguardar a análise da área responsável."
      />
      <BlocoCopiar
        titulo="Comprovante de pagamento"
        texto="O boleto pago ou o comprovante do Pix pode ser utilizado como comprovante de pagamento. Caso necessite de um documento emitido pela instituição, a solicitação pode ser realizada por meio de protocolo no WebAluno."
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

function SecaoSistemas({ ir }) {
  const sistemas = [
    { emoji: "🟢", titulo: "ReATIVA One", tipo: "CRM OPERACIONAL", desc: "Carteira, atendimentos, negociações, retornos, registros e acompanhamento da operação.", href: "/" },
    { emoji: "💬", titulo: "CRM de Mensageria", tipo: "MENSAGERIA", desc: "Envio e consulta de mensagens e contatos relacionados à operação.", href: "https://crm.ulbra.ai/" },
    { emoji: "✉️", titulo: "Gmail", tipo: "E-MAIL", desc: "Canal institucional e alternativa de contato quando necessário.", href: "https://mail.google.com/" },
    { emoji: "📌", titulo: "Prime", tipo: "FINANCEIRO", desc: "Consulta e confirmação de informações financeiras e de acordos.", href: null },
    { emoji: "🧾", titulo: "Folya", tipo: "NOTAS DE SERVIÇO", desc: "Sistema utilizado pelo prestador para envio das informações da comissão, documento assinado e nota fiscal de prestação de serviços.", href: "https://app.getfolya.com/prestador" },
  ];

  return (
    <>
      <TituloSecao
        emoji="🚀"
        titulo="Sistemas e Planilhas"
        sub="Acessos e ferramentas realmente utilizados pela operação, reunidos em um único lugar."
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
            ) : s.titulo === "Prime" ? (
              <button type="button" onClick={() => ir("manualprime")} style={{ ...S.botaoSecundario, marginTop: 14 }}>
                Abrir manual do Prime
              </button>
            ) : (
              <p style={S.observacao}>Utilize o acesso oficial disponibilizado para a equipe.</p>
            )}
          </Card>
        ))}
      </div>

      <TituloSecao
        emoji="🧾"
        titulo="Folya — envio da nota de prestação de serviços"
        sub="Procedimento mensal para validação da comissão, assinatura do documento e envio da nota."
      />

      <Aviso>
        <strong>Regra principal:</strong> não emita nem envie a nota fiscal antes de receber o documento da comissão
        validado e assinado digitalmente pela Angela.
      </Aviso>

      <Card>
        <span style={S.cardTag}>FLUXO DO FECHAMENTO</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>1. Validar o fechamento enviado pela gestão</h3>
        <ol style={S.listaOrdenada}>
          <li>Ao final do mês, a gestão encaminha o fechamento da comissão.</li>
          <li>Confira os valores e valide se o fechamento está correto.</li>
          <li>Se houver divergência, informe a gestão antes de qualquer envio no Folya.</li>
          <li>A gestão fará o ajuste necessário e encaminhará novamente para validação.</li>
          <li>Depois de validado, o documento da comissão será enviado à Angela para assinatura digital.</li>
        </ol>
      </Card>

      <Card>
        <span style={S.cardTag}>PREENCHIMENTO NO FOLYA</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>2. Enviar as informações no sistema</h3>
        <p style={S.paragrafo}>
          O <strong>valor contratual já consta no Folya</strong>. Por isso, no primeiro campo deve ser informado
          somente o <strong>valor da comissão</strong>.
        </p>
        <ol style={{ ...S.listaOrdenada, marginTop: 12 }}>
          <li>
            No primeiro campo, informe o <strong>valor da comissão</strong>.
          </li>
          <li>
            Anexe o <strong>documento da comissão já validado e assinado digitalmente pela Angela</strong>.
          </li>
          <li>
            No próximo anexo, envie a sua <strong>nota fiscal de prestação de serviços</strong>.
          </li>
          <li>
            A nota deve ser emitida pelo <strong>valor total: valor base contratual + comissão</strong>.
          </li>
        </ol>
      </Card>

      <Card style={S.cardLimiteAtuacao}>
        <span style={S.cardTag}>CONFERÊNCIA DE VALORES</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>3. O total precisa fechar exatamente</h3>
        <p style={S.paragrafo}>
          O valor da nota deve corresponder ao total esperado no Folya:
          <strong> valor contratual + comissão</strong>. Se os valores não baterem, o sistema rejeita o envio.
          Nesse caso, confira os valores e faça o ajuste antes de reenviar.
        </p>
      </Card>

      <Card>
        <span style={S.cardTag}>RESPONSABILIDADE DO PRESTADOR</span>
        <h3 style={{ ...S.h3, marginTop: 8 }}>4. Acompanhar o processo até a conclusão</h3>
        <ul style={S.lista}>
          <li>O acompanhamento do <strong>status no Folya</strong> é responsabilidade do prestador.</li>
          <li>Manter <strong>dados bancários, conta e chave Pix</strong> atualizados também é responsabilidade do prestador.</li>
          <li>A gestão informa os valores e comunica quando as informações já podem ser enviadas no aplicativo.</li>
          <li>A gestão não é responsável por acompanhar o status individual do envio ou manter os dados bancários do prestador atualizados.</li>
        </ul>
      </Card>

      <Aviso tom="info">
        <strong>Resumo:</strong> fechamento da comissão → validação pelo prestador → correção de divergências, se houver
        → assinatura digital da Angela → informar comissão no Folya → anexar documento assinado → emitir e anexar nota
        pelo valor base + comissão → acompanhar o status até a conclusão.
      </Aviso>

      <TituloSecao emoji="📊" titulo="Planilhas utilizadas" sub="Materiais de apoio operacional." />
      <div style={S.grade2}>
        <Card>
          <span style={S.cardTag}>PLANILHA OFICIAL</span>
          <h3 style={{ ...S.h3, marginTop: 8 }}>Cálculo de desconto</h3>
          <p style={S.paragrafo}>
            A planilha é uma ferramenta de apoio para montar a condição de negociação conforme a política vigente.
            Ela ajuda o operador a conferir os valores da proposta antes de apresentá-la ao aluno.
          </p>
          <h4 style={{ fontSize: 14, fontWeight: 800, color: "var(--rv-tinta)", margin: "16px 0 6px" }}>Como utilizar</h4>
          <ol style={S.listaOrdenada}>
            <li>Confira primeiro no Prime os valores e a situação correta do débito.</li>
            <li>Consulte a Política de Negociação e identifique qual condição pode ser aplicada ao caso.</li>
            <li>Utilize a planilha para apoiar o cálculo da condição permitida.</li>
            <li>Confira o resultado antes de apresentar a proposta ao aluno.</li>
            <li>Registre no CRM a proposta efetivamente apresentada.</li>
          </ol>
          <p style={{ ...S.paragrafo, marginTop: 12 }}>
            <strong>Importante:</strong> a planilha não cria autorização para desconto ou condição fora da política.
            Se a proposta ultrapassar a regra vigente, deve seguir para análise de exceção.
          </p>
          <a href="https://docs.google.com/spreadsheets/d/19g0v1kikqvMLTHEIZHTg8NKUt6TOxdv2Aiyk41L1Tf4/edit?usp=sharing" target="_blank" rel="noreferrer" style={{ ...S.botaoSecundario, marginTop: 14 }}>
            Abrir planilha
          </a>
        </Card>
      </div>
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

/* ===================== Manual do Prime ===================== */

function CaminhoPrime({ itens }) {
  return (
    <div style={S.primeCaminho}>
      {itens.map((item, i) => (
        <Fragment key={item}>
          <span style={i === itens.length - 1 ? S.primeCaminhoAtual : S.primeCaminhoItem}>{item}</span>
          {i < itens.length - 1 ? <span style={S.primeCaminhoSeta}>→</span> : null}
        </Fragment>
      ))}
    </div>
  );
}

function PassoPrime({ numero, titulo, children }) {
  return (
    <div style={S.primePasso}>
      <div style={S.primePassoNumero}>{numero}</div>
      <div>
        <strong style={S.primePassoTitulo}>{titulo}</strong>
        <div style={S.primePassoTexto}>{children}</div>
      </div>
    </div>
  );
}

function SecaoManualPrime({ ir }) {
  const irPara = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <div style={S.primeHero}>
        <div style={S.primeHeroTexto}>
          <span style={S.heroEyebrow}>MANUAL OPERACIONAL</span>
          <h1 style={S.primeHeroTitulo}>Prime, sem complicação.</h1>
          <p style={S.primeHeroSub}>
            Consulte os caminhos usados pela ReATIVA para atendimento, títulos, acordos e aplicação de condições especiais.
            O objetivo é encontrar o que você precisa durante o atendimento em poucos segundos.
          </p>
          <div style={S.heroAcoes}>
            <button type="button" onClick={() => irPara("prime-painel")} style={S.botaoPrimario}>Começar pelo atendimento</button>
            <button type="button" onClick={() => irPara("prime-desconto")} style={S.botaoSecundario}>Aplicar desconto</button>
          </div>
        </div>
        <div style={S.primeHeroBadge}>
          <span style={S.primeHeroBadgeIcon}>P</span>
          <strong>PRIME</strong>
          <span>Guia rápido ReATIVA</span>
        </div>
      </div>

      <div style={S.primeAtalhos}>
        {[
          ["01", "Painel de Atendimento", "prime-painel"],
          ["02", "Títulos a Receber", "prime-titulos"],
          ["03", "Acordos", "prime-acordos"],
          ["04", "Condições Especiais", "prime-condicoes"],
          ["05", "Aplicar desconto", "prime-desconto"],
        ].map(([n, titulo, alvo]) => (
          <button key={alvo} type="button" onClick={() => irPara(alvo)} style={S.primeAtalhoCard}>
            <span style={S.primeAtalhoNumero}>{n}</span>
            <strong>{titulo}</strong>
            <span style={S.primeAtalhoSeta}>↓</span>
          </button>
        ))}
      </div>

      <Aviso tom="info">
        <strong>Use este manual como mapa de navegação.</strong> Ele organiza somente os procedimentos que já estão
        documentados no material operacional fornecido pela gestão. Para informações financeiras do aluno, siga as regras
        de validação e conferência vigentes antes de qualquer tratativa.
      </Aviso>

      <section id="prime-painel" style={S.primeSecao}>
        <div style={S.primeSecaoCabecalho}>
          <div>
            <span style={S.cardTag}>01 · ATENDIMENTO</span>
            <h2 style={S.primeSecaoTitulo}>Acessar o Painel de Atendimento</h2>
            <p style={S.paragrafo}>É o ponto de entrada para localizar e acompanhar o atendimento do aluno no Prime.</p>
          </div>
          <span style={S.primeIconeGrande}>◫</span>
        </div>
        <Card style={S.primeCardDestaque}>
          <span style={S.primeMiniLabel}>CAMINHO NO MENU</span>
          <CaminhoPrime itens={["☰ Menu", "Atendimento", "Painel de Atendimento"]} />
        </Card>
        <div style={S.grade2}>
          <PassoPrime numero="1" titulo="Abra o menu principal">Clique no ícone de três linhas no canto superior do Prime.</PassoPrime>
          <PassoPrime numero="2" titulo="Entre em Atendimento">No menu, localize a área Atendimento.</PassoPrime>
          <PassoPrime numero="3" titulo="Abra o Painel de Atendimento">Selecione Painel de Atendimento para iniciar a consulta.</PassoPrime>
        </div>
      </section>

      <section id="prime-titulos" style={S.primeSecao}>
        <div style={S.primeSecaoCabecalho}>
          <div>
            <span style={S.cardTag}>02 · FINANCEIRO</span>
            <h2 style={S.primeSecaoTitulo}>Consultar Títulos a Receber</h2>
            <p style={S.paragrafo}>Use essa área para acessar os títulos financeiros do aluno.</p>
          </div>
          <span style={S.primeIconeGrande}>▤</span>
        </div>
        <Card style={S.primeCardDestaque}>
          <span style={S.primeMiniLabel}>CAMINHO NO MENU</span>
          <CaminhoPrime itens={["☰ Menu", "RECEBER", "Títulos a Receber"]} />
        </Card>
        <div style={S.grade2}>
          <PassoPrime numero="1" titulo="Abra o menu">Acesse o menu lateral do Prime.</PassoPrime>
          <PassoPrime numero="2" titulo="Localize RECEBER">Expanda a área RECEBER.</PassoPrime>
          <PassoPrime numero="3" titulo="Selecione Títulos a Receber">Entre na opção para consultar os títulos financeiros disponíveis.</PassoPrime>
        </div>
      </section>

      <section id="prime-acordos" style={S.primeSecao}>
        <div style={S.primeSecaoCabecalho}>
          <div>
            <span style={S.cardTag}>03 · ACORDOS</span>
            <h2 style={S.primeSecaoTitulo}>Acessar os Acordos</h2>
            <p style={S.paragrafo}>O acesso pode ser feito pelo menu RECEBER ou pelo botão Acordos disponível na ficha financeira do aluno.</p>
          </div>
          <span style={S.primeIconeGrande}>◇</span>
        </div>
        <div style={S.grade2}>
          <Card style={S.primeCardDestaque}>
            <span style={S.primeMiniLabel}>PELO MENU</span>
            <CaminhoPrime itens={["☰ Menu", "RECEBER", "Acordos", "Acordos"]} />
          </Card>
          <Card style={S.primeCardDestaque}>
            <span style={S.primeMiniLabel}>PELA FICHA DO ALUNO</span>
            <CaminhoPrime itens={["Ficha financeira", "Botão Acordos"]} />
          </Card>
        </div>
        <Aviso tom="info">
          <strong>Lembrete operacional:</strong> se houver acordo em aberto ou vencido, a negociação do acordo é prioridade
          antes das mensalidades.
        </Aviso>
      </section>

      <section id="prime-condicoes" style={S.primeSecao}>
        <div style={S.primeSecaoCabecalho}>
          <div>
            <span style={S.cardTag}>04 · CONDIÇÕES ESPECIAIS</span>
            <h2 style={S.primeSecaoTitulo}>Acessar Condições Especiais para Acordo</h2>
            <p style={S.paragrafo}>É o caminho utilizado no material para cadastrar a condição que será usada na aplicação de desconto.</p>
          </div>
          <span style={S.primeIconeGrande}>%</span>
        </div>
        <Card style={S.primeCardDestaque}>
          <span style={S.primeMiniLabel}>CAMINHO NO MENU</span>
          <CaminhoPrime itens={["☰ Menu", "RECEBER", "Acordos", "Condições Especiais para Acordo"]} />
        </Card>
        <PassoPrime numero="1" titulo="Entre em Condições Especiais para Acordo">
          Na tela de seleção, clique em <strong>Incluir condição de acordo</strong>.
        </PassoPrime>
      </section>

      <section id="prime-desconto" style={S.primeSecao}>
        <div style={S.primeSecaoCabecalho}>
          <div>
            <span style={S.cardTag}>05 · APLICAÇÃO DE DESCONTO</span>
            <h2 style={S.primeSecaoTitulo}>Cadastrar a condição corretamente</h2>
            <p style={S.paragrafo}>O material define duas regras obrigatórias para o preenchimento.</p>
          </div>
          <span style={S.primeIconeGrande}>✓</span>
        </div>

        <div style={S.primeRegraGrid}>
          <Card style={S.primeRegraCard}>
            <span style={S.primeRegraNumero}>01</span>
            <h3 style={S.h3}>Nome completo do aluno</h3>
            <p style={S.paragrafo}>No campo <strong>Aluno</strong>, informe o nome completo.</p>
          </Card>
          <Card style={S.primeRegraCard}>
            <span style={S.primeRegraNumero}>02</span>
            <h3 style={S.h3}>Validade dentro do mês vigente</h3>
            <p style={S.paragrafo}>O período informado deve começar e terminar dentro do mesmo mês vigente.</p>
          </Card>
        </div>

        <Card style={S.primeExemplo}>
          <span style={S.primeMiniLabel}>EXEMPLO DO MATERIAL</span>
          <div style={S.primeExemploLinha}>
            <span>Válido de</span>
            <strong>01/09</strong>
            <span>até</span>
            <strong>30/09</strong>
          </div>
          <p style={{ ...S.paragrafo, margin: "10px 0 0" }}>
            Após preencher aluno, validade e texto da condição, utilize <strong>Gravar</strong>.
          </p>
        </Card>

        <Aviso>
          <strong>Atenção:</strong> este manual ensina o caminho e o preenchimento documentados no Prime.
          Ele não substitui a Política de Negociação e não autoriza desconto fora das regras vigentes.
        </Aviso>
      </section>

      <section style={S.primeSecao}>
        <div style={S.primeResumoFinal}>
          <div>
            <span style={S.cardTag}>CONSULTA RÁPIDA</span>
            <h2 style={S.primeSecaoTitulo}>Qual caminho você precisa agora?</h2>
          </div>
          <div style={S.primeResumoBotoes}>
            <button type="button" onClick={() => irPara("prime-titulos")} style={S.botaoSecundario}>Títulos</button>
            <button type="button" onClick={() => irPara("prime-acordos")} style={S.botaoSecundario}>Acordos</button>
            <button type="button" onClick={() => irPara("prime-desconto")} style={S.botaoPrimario}>Desconto</button>
            <button type="button" onClick={() => ir("politica")} style={S.botaoSecundario}>Política de Negociação</button>
          </div>
        </div>
      </section>
    </>
  );
}

/* ===================== DDDs das Unidades ===================== */

function SecaoDdds() {
  const unidades = [
    ["Cachoeira do Sul", "RS", "51"],
    ["Canoas", "RS", "51"],
    ["Carazinho", "RS", "54"],
    ["EAD", "-", "Conforme polo/unidade do aluno"],
    ["Gravataí", "RS", "51"],
    ["Guaíba", "RS", "51"],
    ["Itumbiara", "GO", "64"],
    ["Manaus", "AM", "92"],
    ["Palmas", "TO", "63"],
    ["Porto Alegre", "RS", "51"],
    ["Santa Maria", "RS", "55"],
    ["Santarém", "PA", "93"],
    ["São Jerônimo", "RS", "51"],
    ["Torres", "RS", "51"],
  ];

  return (
    <>
      <TituloSecao
        emoji="📞"
        titulo="DDDs das Unidades"
        sub="Consulta rápida do código de área das cidades onde a Ulbra possui unidades atendidas pela operação."
      />

      <Aviso tom="info">
        <strong>Importante:</strong> o DDD ajuda a identificar a região de origem do número, mas não confirma sozinho
        a unidade do aluno. Sempre valide a unidade e os dados cadastrais no sistema antes de concluir.
      </Aviso>

      <Card>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Unidade</th>
              <th style={S.th}>UF</th>
              <th style={S.th}>DDD</th>
            </tr>
          </thead>
          <tbody>
            {unidades.map(([unidade, uf, ddd]) => (
              <tr key={unidade}>
                <td style={S.td}><strong>{unidade}</strong></td>
                <td style={S.td}>{uf}</td>
                <td style={S.td}>{ddd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
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
  primeHero: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 28,
    alignItems: "center",
    background: "linear-gradient(135deg, var(--rv-superficie) 0%, var(--rv-azul-fundo) 100%)",
    border: "1px solid var(--rv-azul-borda)",
    borderRadius: 28,
    padding: "44px 46px",
    marginBottom: 18,
    boxShadow: "0 16px 44px rgba(15,23,42,0.07)",
  },
  primeHeroTexto: { maxWidth: 830 },
  primeHeroTitulo: {
    fontFamily: FONTE_TITULO,
    fontSize: 40,
    lineHeight: 1.08,
    letterSpacing: "-0.04em",
    margin: "9px 0 12px",
    color: "var(--rv-tinta)",
  },
  primeHeroSub: { fontSize: 16.5, lineHeight: 1.65, color: "var(--rv-texto-suave)", margin: 0 },
  primeHeroBadge: {
    width: 176,
    minHeight: 176,
    borderRadius: 24,
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-azul-borda)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    boxShadow: "0 10px 30px rgba(15,23,42,0.06)",
    color: "var(--rv-tinta)",
  },
  primeHeroBadgeIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    display: "grid",
    placeItems: "center",
    background: "var(--rv-azul)",
    color: "#fff",
    fontFamily: FONTE_TITULO,
    fontSize: 28,
    fontWeight: 900,
    marginBottom: 5,
  },
  primeAtalhos: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    margin: "18px 0",
  },
  primeAtalhoCard: {
    border: "1px solid var(--rv-borda)",
    background: "var(--rv-superficie)",
    color: "var(--rv-tinta)",
    borderRadius: 16,
    padding: "16px",
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    gap: 10,
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  primeAtalhoNumero: { fontSize: 11, fontWeight: 900, color: VERDE_ESCURO, letterSpacing: "0.08em" },
  primeAtalhoSeta: { color: "var(--rv-texto-fraco)", fontSize: 16 },
  primeSecao: {
    scrollMarginTop: 24,
    paddingTop: 28,
    marginTop: 14,
    borderTop: "1px solid var(--rv-borda-suave)",
  },
  primeSecaoCabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 20,
    marginBottom: 16,
  },
  primeSecaoTitulo: {
    fontFamily: FONTE_TITULO,
    fontSize: 25,
    color: "var(--rv-tinta)",
    margin: "7px 0 5px",
    letterSpacing: "-0.025em",
  },
  primeIconeGrande: {
    minWidth: 56,
    height: 56,
    borderRadius: 18,
    display: "grid",
    placeItems: "center",
    border: "1px solid var(--rv-azul-borda)",
    background: "var(--rv-azul-fundo)",
    color: VERDE_ESCURO,
    fontSize: 24,
    fontWeight: 900,
  },
  primeCardDestaque: {
    background: "var(--rv-fundo-suave)",
    border: "1px solid var(--rv-borda)",
  },
  primeMiniLabel: {
    display: "block",
    fontSize: 10.5,
    fontWeight: 900,
    color: "var(--rv-texto-fraco)",
    letterSpacing: "0.1em",
    marginBottom: 10,
  },
  primeCaminho: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
  primeCaminhoItem: {
    padding: "9px 12px",
    borderRadius: 10,
    background: "var(--rv-superficie)",
    border: "1px solid var(--rv-borda)",
    fontSize: 13.5,
    fontWeight: 750,
    color: "var(--rv-texto)",
  },
  primeCaminhoAtual: {
    padding: "9px 12px",
    borderRadius: 10,
    background: "var(--rv-azul-fundo)",
    border: "1px solid var(--rv-azul-borda)",
    fontSize: 13.5,
    fontWeight: 850,
    color: VERDE_ESCURO,
  },
  primeCaminhoSeta: { color: "var(--rv-texto-fraco)", fontWeight: 900 },
  primePasso: {
    display: "grid",
    gridTemplateColumns: "42px 1fr",
    gap: 13,
    alignItems: "start",
    padding: "17px 0",
  },
  primePassoNumero: {
    width: 38,
    height: 38,
    display: "grid",
    placeItems: "center",
    borderRadius: 12,
    background: "var(--rv-azul-fundo)",
    border: "1px solid var(--rv-azul-borda)",
    color: VERDE_ESCURO,
    fontWeight: 900,
    fontSize: 12,
  },
  primePassoTitulo: { display: "block", fontSize: 15, color: "var(--rv-tinta)", marginBottom: 5 },
  primePassoTexto: { fontSize: 14.2, lineHeight: 1.55, color: "var(--rv-texto-suave)" },
  primeRegraGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 16,
  },
  primeRegraCard: {
    position: "relative",
    overflow: "hidden",
    minHeight: 150,
  },
  primeRegraNumero: {
    display: "inline-flex",
    padding: "5px 8px",
    borderRadius: 8,
    background: "var(--rv-azul-fundo)",
    color: VERDE_ESCURO,
    fontSize: 11,
    fontWeight: 900,
    marginBottom: 9,
  },
  primeExemplo: {
    marginTop: 16,
    background: "linear-gradient(135deg, var(--rv-superficie), var(--rv-fundo-suave))",
  },
  primeExemploLinha: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    alignItems: "center",
    fontSize: 15,
  },
  primeResumoFinal: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 24,
    padding: "24px",
    borderRadius: 20,
    background: "var(--rv-fundo-suave)",
    border: "1px solid var(--rv-borda)",
  },
  primeResumoBotoes: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },

};
