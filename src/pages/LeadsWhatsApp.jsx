// LEADS DO WHATSAPP — registro manual de quem procurou a operação.
//
// POR QUE ESTA TELA EXISTE: enquanto a integração oficial com a Meta não sai,
// os operadores atendem no celular e o contato de quem escreveu se perde junto
// com a memória do aparelho. Aqui o lead fica registrado.
//
// O QUE ELA NÃO É: não é a Central WhatsApp. Não recebe nem envia mensagem.
// O botão "Abrir WhatsApp" abre a conversa no WhatsApp do próprio operador —
// é um atalho, não um envio pelo CRM.
//
// Não tem vínculo com ficha de aluno, igual à Central.
import { useCallback, useEffect, useState } from "react";
import { formatarTelefone, normalizarE164 } from "../utils/telefone";
import {
  ROTULO_STATUS,
  atualizarLead,
  esperaDesde,
  linkWhatsApp,
  listarCanais,
  listarLeads,
  registrarLead,
} from "../services/whatsapp";

// Lead ainda sem resposta = está esperando. Encerrado e respondido saem da conta.
function aguardando(lead) {
  return lead.status === "NOVO" || lead.status === "EM_ATENDIMENTO";
}

const FILTROS = [
  { valor: "", rotulo: "Todos" },
  { valor: "NOVO", rotulo: "Novos" },
  { valor: "EM_ATENDIMENTO", rotulo: "Em atendimento" },
  { valor: "RESPONDIDO", rotulo: "Respondidos" },
  { valor: "ENCERRADO", rotulo: "Encerrados" },
];

const VAZIO = { telefone: "", nome: "", canalId: "", assunto: "" };

function quando(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function LeadsWhatsApp() {
  const [leads, setLeads] = useState([]);
  const [canais, setCanais] = useState([]);
  const [filtro, setFiltro] = useState("");
  const [busca, setBusca] = useState("");
  const [form, setForm] = useState(VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setLeads(await listarLeads({ status: filtro, busca }));
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregando(false);
    }
  }, [filtro, busca]);

  useEffect(() => {
    listarCanais().then(setCanais).catch(() => setCanais([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(carregar, busca ? 350 : 0);
    return () => clearTimeout(t);
  }, [carregar, busca]);

  const telefoneValido = Boolean(normalizarE164(form.telefone));

  async function registrar(e) {
    e?.preventDefault();
    if (!telefoneValido || salvando) return;
    setSalvando(true);
    setErro("");
    setAviso("");
    try {
      const quantosAntes = leads.length;
      await registrarLead({
        telefone: form.telefone,
        nome: form.nome,
        canalId: form.canalId,
        assunto: form.assunto,
      });
      setForm(VAZIO);
      const novos = await listarLeads({ status: filtro, busca });
      setLeads(novos);
      // A RPC devolve o lead existente em vez de duplicar; se a lista não
      // cresceu, avisa em vez de deixar o operador achar que sumiu.
      if (novos.length === quantosAntes) {
        setAviso("Já havia um lead aberto para esse telefone — ele continua na lista.");
      }
    } catch (e2) {
      setErro(e2.message);
    } finally {
      setSalvando(false);
    }
  }

  async function mudar(id, dados) {
    setErro("");
    try {
      await atualizarLead(id, dados);
      await carregar();
    } catch (e) {
      setErro(e.message);
    }
  }

  return (
    <div style={S.pagina}>
      <div style={S.cabecalho}>
        <h1 style={S.titulo}>Leads do WhatsApp</h1>
        <p style={S.subtitulo}>
          Registro de quem procurou a operação, para nenhum contato se perder
          enquanto a integração não entra.
        </p>
        {(() => {
          const esperando = leads.filter(aguardando);
          if (esperando.length === 0) return null;
          const antigos = esperando.filter((l) => {
            const e = esperaDesde(l.registrado_em);
            return e && e.nivel === "critico";
          });
          return (
            <div style={antigos.length ? S.contadorAlerta : S.contador}>
              <strong>{esperando.length}</strong> esperando resposta
              {antigos.length ? ` · ${antigos.length} há mais de 24h` : ""}
            </div>
          );
        })()}
      </div>

      <div style={S.nota}>
        Esta tela <strong>não envia mensagem</strong>. O botão abre a conversa no
        WhatsApp do seu celular ou navegador — o atendimento continua sendo feito
        por lá até os números serem conectados.
      </div>

      {erro ? (
        <div style={S.erro}>
          {erro}
          <button style={S.fechar} onClick={() => setErro("")}>×</button>
        </div>
      ) : null}
      {aviso ? (
        <div style={S.aviso}>
          {aviso}
          <button style={S.fechar} onClick={() => setAviso("")}>×</button>
        </div>
      ) : null}

      {/* ---------------- Registrar ---------------- */}
      <form style={S.caixa} onSubmit={registrar}>
        <div style={S.tituloCaixa}>Registrar quem chamou</div>
        <div style={S.linhaForm}>
          <input
            style={S.campo}
            placeholder="Telefone com DDD *"
            value={form.telefone}
            onChange={(e) => setForm((f) => ({ ...f, telefone: e.target.value }))}
          />
          <input
            style={S.campo}
            placeholder="Nome (se souber)"
            value={form.nome}
            onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
          />
          {canais.length > 0 ? (
            <select
              style={S.campo}
              value={form.canalId}
              onChange={(e) => setForm((f) => ({ ...f, canalId: e.target.value }))}
            >
              <option value="">Qual número recebeu?</option>
              {canais.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.apelido} · {c.display_phone_number}
                </option>
              ))}
            </select>
          ) : null}
          <input
            style={{ ...S.campo, flex: 2 }}
            placeholder="O que a pessoa queria"
            value={form.assunto}
            onChange={(e) => setForm((f) => ({ ...f, assunto: e.target.value }))}
          />
          <button
            type="submit"
            style={telefoneValido && !salvando ? S.botao : S.botaoOff}
            disabled={!telefoneValido || salvando}
          >
            {salvando ? "Salvando…" : "Registrar"}
          </button>
        </div>
        {form.telefone && !telefoneValido ? (
          <div style={S.dicaErro}>
            Telefone incompleto — informe DDD + número.
          </div>
        ) : null}
      </form>

      {/* ---------------- Lista ---------------- */}
      <div style={S.filtros}>
        <div style={S.chips}>
          {FILTROS.map((f) => (
            <button
              key={f.valor || "todos"}
              onClick={() => setFiltro(f.valor)}
              style={filtro === f.valor ? S.chipAtivo : S.chip}
            >
              {f.rotulo}
            </button>
          ))}
        </div>
        <input
          style={S.busca}
          placeholder="Buscar por telefone, nome ou assunto"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>

      <div style={S.caixa}>
        {carregando ? (
          <div style={S.vazio}>Carregando…</div>
        ) : leads.length === 0 ? (
          <div style={S.vazio}>
            Nenhum lead registrado ainda.
            <br />
            <span style={S.vazioDica}>
              Use o formulário acima assim que alguém chamar.
            </span>
          </div>
        ) : (
          <div style={S.tabela}>
            {leads.map((l) => (
              <div key={l.id} style={S.linha} data-testid={`lead-${l.id}`}>
                <div style={S.colPrincipal}>
                  <div style={S.nome}>
                    {l.nome || formatarTelefone(l.telefone_e164)}
                  </div>
                  <div style={S.meta}>
                    {formatarTelefone(l.telefone_e164)}
                    {l.canal_apelido ? ` · recebido em ${l.canal_apelido}` : ""}
                    {` · ${quando(l.registrado_em)}`}
                  </div>
                  {l.assunto ? <div style={S.assunto}>{l.assunto}</div> : null}
                  {l.operador_email ? (
                    <div style={S.meta}>com {l.operador_email}</div>
                  ) : null}
                </div>

                <div style={S.colAcoes}>
                  {/* Quanto tempo essa pessoa está esperando — é o que diz
                      para quem responder primeiro. */}
                  {aguardando(l) && esperaDesde(l.registrado_em) ? (
                    <span style={S.espera[esperaDesde(l.registrado_em).nivel]}>
                      esperando {esperaDesde(l.registrado_em).texto}
                    </span>
                  ) : (
                    <span style={S.etiqueta}>{ROTULO_STATUS[l.status] || l.status}</span>
                  )}

                  <a
                    style={S.botaoZap}
                    href={linkWhatsApp(l.telefone_e164) || undefined}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => {
                      if (l.status === "NOVO") mudar(l.id, { status: "EM_ATENDIMENTO", assumir: true });
                    }}
                  >
                    Abrir WhatsApp
                  </a>

                  {l.status !== "RESPONDIDO" && l.status !== "ENCERRADO" ? (
                    <button
                      style={S.botaoSec}
                      onClick={() => mudar(l.id, { status: "RESPONDIDO", assumir: true })}
                    >
                      Respondido
                    </button>
                  ) : null}
                  {l.status !== "ENCERRADO" ? (
                    <button style={S.botaoSec} onClick={() => mudar(l.id, { status: "ENCERRADO" })}>
                      Encerrar
                    </button>
                  ) : (
                    <button style={S.botaoSec} onClick={() => mudar(l.id, { status: "NOVO" })}>
                      Reabrir
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  pagina: { padding: 16, maxWidth: 1200, margin: "0 auto" },
  cabecalho: { marginBottom: 10 },
  titulo: { fontSize: 20, margin: 0, color: "var(--rv-tinta)" },
  subtitulo: { fontSize: 13, color: "var(--rv-texto-suave)", margin: "4px 0 0" },

  contador: {
    display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--rv-texto)",
    background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)", borderRadius: 999, padding: "3px 11px",
  },
  contadorAlerta: {
    display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--rv-vermelho-texto)",
    background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", borderRadius: 999, padding: "3px 11px",
  },
  nota: {
    background: "var(--rv-azul-fundo)", border: "1px solid var(--rv-azul-borda)", color: "var(--rv-azul-texto)",
    borderRadius: 10, padding: "9px 12px", fontSize: 12, lineHeight: 1.45, marginBottom: 12,
  },
  erro: {
    background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", color: "var(--rv-vermelho-texto)",
    borderRadius: 10, padding: "9px 12px", fontSize: 13, marginBottom: 10,
    display: "flex", justifyContent: "space-between", gap: 8,
  },
  aviso: {
    background: "var(--rv-ambar-fundo)", border: "1px solid var(--rv-ambar-borda)", color: "var(--rv-ambar-texto)",
    borderRadius: 10, padding: "9px 12px", fontSize: 13, marginBottom: 10,
    display: "flex", justifyContent: "space-between", gap: 8,
  },
  fechar: { background: "none", border: "none", fontSize: 18, cursor: "pointer", lineHeight: 1, color: "inherit" },

  caixa: {
    background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14,
    padding: 14, marginBottom: 12,
  },
  tituloCaixa: { fontSize: 13, fontWeight: 600, color: "var(--rv-tinta)", marginBottom: 9 },
  linhaForm: { display: "flex", gap: 8, flexWrap: "wrap" },
  campo: {
    flex: 1, minWidth: 150, padding: "8px 10px", borderRadius: 9,
    border: "1px solid var(--rv-borda)", fontSize: 13, boxSizing: "border-box",
  },
  dicaErro: { fontSize: 12, color: "var(--rv-vermelho-texto)", marginTop: 6 },

  filtros: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  chips: { display: "flex", gap: 5, flexWrap: "wrap" },
  chip: {
    padding: "5px 11px", borderRadius: 999, border: "1px solid var(--rv-borda)",
    background: "var(--rv-superficie)", color: "var(--rv-texto)", fontSize: 12, cursor: "pointer",
  },
  chipAtivo: {
    padding: "5px 11px", borderRadius: 999, border: "1px solid #1d4ed8",
    background: "#1d4ed8", color: "#fff", fontSize: 12, cursor: "pointer",
  },
  busca: {
    marginLeft: "auto", minWidth: 240, padding: "7px 10px", borderRadius: 9,
    border: "1px solid var(--rv-borda)", fontSize: 13,
  },

  tabela: { display: "grid", gap: 6 },
  linha: {
    display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
    background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "10px 12px",
  },
  colPrincipal: { flex: 1, minWidth: 220 },
  colAcoes: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  nome: { fontSize: 13, fontWeight: 600, color: "var(--rv-tinta)" },
  meta: { fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 2 },
  assunto: { fontSize: 12, color: "var(--rv-texto)", marginTop: 4 },
  etiqueta: { fontSize: 10, background: "var(--rv-fundo-suave)", color: "var(--rv-texto)", padding: "2px 8px", borderRadius: 999 },
  // Escala de espera: quanto mais tempo sem resposta, mais forte a cor.
  espera: {
    calmo: { fontSize: 10, background: "var(--rv-fundo-suave)", color: "var(--rv-texto)", padding: "2px 8px", borderRadius: 999 },
    atencao: { fontSize: 10, background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", padding: "2px 8px", borderRadius: 999 },
    critico: { fontSize: 10, background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)", padding: "2px 8px", borderRadius: 999, fontWeight: 600 },
  },

  botao: { padding: "8px 16px", borderRadius: 9, border: "none", background: "#1d4ed8", color: "#fff", fontSize: 13, cursor: "pointer" },
  botaoOff: { padding: "8px 16px", borderRadius: 9, border: "none", background: "var(--rv-borda-forte)", color: "#fff", fontSize: 13, cursor: "not-allowed" },
  botaoZap: {
    padding: "5px 11px", borderRadius: 8, border: "1px solid var(--rv-verde-ok-borda)",
    background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", fontSize: 12, cursor: "pointer", textDecoration: "none",
  },
  botaoSec: { padding: "5px 11px", borderRadius: 8, border: "1px solid var(--rv-borda)", background: "var(--rv-superficie)", color: "var(--rv-texto)", fontSize: 12, cursor: "pointer" },

  vazio: { padding: 22, textAlign: "center", color: "var(--rv-texto-fraco)", fontSize: 13 },
  vazioDica: { fontSize: 12, color: "#cbd5e1" },
};
