import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import { nomeOperadorPorEmail } from "../utils/operadores";
import Aluno from "./Aluno";

// Acordos duplicados que a importação deixou entrar.
//
// POR QUE ELES ENTRAM (Amanda, 27/08/2026): "na importação de acordo, o sistema
// deveria sinalizar as duplicidades e importar normalmente".
//
// A trava de acordo duplicado continua barrando quem lança à mão -- a pessoa
// está ali, lê o aviso e decide. Mas a importação insere tudo num comando só:
// uma linha duplicada derrubava o lote INTEIRO. O arquivo vem da Prime e não dá
// para editar antes, então a importação simplesmente travava.
//
// Agora ela entra e fica MARCADA (acordos.duplicado_de). Esta tela é o outro
// lado da marca -- sinalizar só serve se alguém consegue ver.
//
// NÃO TEM BOTÃO DE CANCELAR, de propósito. Cancelar um acordo devolve a dívida
// para o aluno e a Prime não reverte isso sozinha. A decisão é caso a caso, na
// ficha, olhando o que cada um dos dois já recebeu.

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataHora(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "-";
  }
}

export default function AcordosDuplicados() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [ehGestao, setEhGestao] = useState(false);
  const [operadorFiltro, setOperadorFiltro] = useState("");
  const [fichaId, setFichaId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.rpc("usuario_e_gestao");
        setEhGestao(data === true);
      } catch {
        setEhGestao(false);
      }
      await carregar("");
    })();
  }, []);

  async function carregar(email) {
    setCarregando(true);
    setErro("");
    try {
      // Operador: a RPC ignora p_email e devolve so os dele.
      const { data, error } = await supabase.rpc("acordos_duplicados_sinalizados", {
        p_email: email || null,
      });
      if (error) throw error;
      setLinhas(data || []);
    } catch (e) {
      setErro(e?.message || String(e));
      setLinhas([]);
    } finally {
      setCarregando(false);
    }
  }

  const filtradas = useMemo(() => {
    if (!busca.trim()) return linhas;
    const t = busca.trim().toLowerCase();
    return linhas.filter((l) =>
      [l.aluno_nome, l.cpf].filter(Boolean).some((c) => String(c).toLowerCase().includes(t))
    );
  }, [linhas, busca]);

  const operadores = useMemo(() => {
    const set = new Set(linhas.map((l) => l.operador_email).filter(Boolean));
    return [...set].sort();
  }, [linhas]);

  const total = useMemo(
    () => filtradas.reduce((s, l) => s + Number(l.valor_total || 0), 0),
    [filtradas],
  );

  if (carregando) {
    return <div style={A.wrap}><Carregando texto="Procurando duplicidades sinalizadas…" /></div>;
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Acordos duplicados</h1>
          <p style={A.sub}>
            Acordos <b>ATIVOS</b> repetidos: mesmo aluno, mesmo valor e a mesma quantidade de
            parcelas. Entram tanto os que a importação deixou passar marcados quanto os que já
            estavam na base antes da trava existir. Aqui você vê a cópia e a original lado a lado.
            Quando sobra um só ativo, a linha some sozinha — a duplicidade foi resolvida.
          </p>
        </div>
        <button type="button" style={A.btnGhost} onClick={() => carregar(operadorFiltro)}>Atualizar</button>
      </div>

      {erro && <div style={A.erroBox}>⚠️ {erro}</div>}

      <div style={estilos.aviso}>
        <b>Antes de cancelar, olhe as parcelas pagas dos dois.</b> Cancelar um acordo devolve a
        dívida para o aluno, e a Prime não reverte isso sozinha. Se o novo substitui o antigo,
        cancele o antigo pela ficha; se são acordos diferentes de verdade, é só deixar como está.
      </div>

      <div style={A.barra}>
        {ehGestao && (
          <select
            style={A.select}
            value={operadorFiltro}
            onChange={(e) => { setOperadorFiltro(e.target.value); carregar(e.target.value); }}
          >
            <option value="">Todos os operadores</option>
            {operadores.map((o) => <option key={o} value={o}>{nomeOperadorPorEmail(o) || o}</option>)}
          </select>
        )}
        <input
          style={A.input}
          placeholder="Buscar por aluno ou CPF..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <div style={A.contadores}>
          <span style={A.contadorAlunos}>{filtradas.length} duplicidades</span>
          <span style={A.contadorValor}>{moeda(total)}</span>
        </div>
      </div>

      {filtradas.length === 0 ? (
        <p style={A.muted}>Nenhuma duplicidade sinalizada. As importações entraram limpas.</p>
      ) : (
        <div style={A.cards}>
          {filtradas.map((l) => (
            <div key={l.acordo_id} style={A.card}>
              <div style={A.cardHead}>
                <div style={A.cardHeadInfo}>
                  <span style={A.cardNome}>{l.aluno_nome}</span>
                  <span style={estilos.cpf}>{l.cpf || "-"}</span>
                  <span style={l.origem === "IMPORTACAO" ? estilos.origemImport : estilos.origemAntiga}>
                    {l.origem === "IMPORTACAO" ? "marcado na importação" : "anterior à trava"}
                  </span>
                  {l.no_grupo > 2 && (
                    <span style={estilos.grupoGrande}>{l.no_grupo} acordos iguais</span>
                  )}
                </div>
                <div style={A.cardHeadDir}>
                  <span style={A.cardResumo}>
                    {moeda(l.valor_total)} em {l.qtd_parcelas}x
                  </span>
                  {l.operador_email && (
                    <span style={estilos.operador}>
                      {nomeOperadorPorEmail(l.operador_email) || l.operador_email}
                    </span>
                  )}
                  <button type="button" style={A.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                    Abrir ficha
                  </button>
                </div>
              </div>

              <div style={estilos.lado}>
                <div style={{ ...estilos.coluna, borderColor: "#fde68a", background: "#fffbeb" }}>
                  <span style={estilos.colRot}>A cópia</span>
                  <span style={estilos.colNum}>nº {l.numero_acordo ?? "sem número"}</span>
                  <span style={estilos.colDet}>criado em {dataHora(l.criado_em)}</span>
                  <span style={estilos.colDet}>
                    {l.parcelas_novo} parcela{l.parcelas_novo === 1 ? "" : "s"} ·{" "}
                    <b>{l.parcelas_pagas_novo} paga{l.parcelas_pagas_novo === 1 ? "" : "s"}</b>
                  </span>
                </div>
                <div style={{ ...estilos.coluna, borderColor: "#e2e8f0", background: "#f8fafc" }}>
                  <span style={estilos.colRot}>Já existia</span>
                  <span style={estilos.colNum}>nº {l.existente_numero ?? "sem número"}</span>
                  <span style={estilos.colDet}>criado em {dataHora(l.existente_criado_em)}</span>
                  <span style={estilos.colDet}>
                    {l.parcelas_existente} parcela{l.parcelas_existente === 1 ? "" : "s"} ·{" "}
                    <b>{l.parcelas_pagas_existente} paga{l.parcelas_pagas_existente === 1 ? "" : "s"}</b>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {fichaId && (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <span style={A.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...A.modalFechar, marginLeft: "auto" }}
                onClick={() => { setFichaId(null); carregar(operadorFiltro); }}
              >
                Fechar ✕
              </button>
            </div>
            <div style={A.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  aviso: {
    background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
    borderRadius: 10, padding: "12px 14px", fontSize: 13, lineHeight: 1.55, marginBottom: 14,
  },
  cpf: { fontSize: 12.5, color: "#64748b" },
  origemImport: {
    fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 9px",
    background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a", whiteSpace: "nowrap",
  },
  origemAntiga: {
    fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 9px",
    background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0", whiteSpace: "nowrap",
  },
  grupoGrande: {
    fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "2px 9px",
    background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", whiteSpace: "nowrap",
  },
  operador: { fontSize: 12.5, color: "#64748b" },
  lado: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, padding: "10px 14px 14px" },
  coluna: {
    border: "1px solid", borderRadius: 10, padding: "10px 12px",
    display: "flex", flexDirection: "column", gap: 3,
  },
  colRot: { fontSize: 11.5, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" },
  colNum: { fontSize: 15, fontWeight: 800, color: "#0d1321" },
  colDet: { fontSize: 12.5, color: "#475569" },
};
