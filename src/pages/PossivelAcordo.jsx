// Possivel acordo: quem pagou alguma coisa, ainda deve e NAO tem acordo.
//
// Ideia da Amanda: "os alunos que tem pagamento menor que o saldo, poderia
// criar como possibilidade de acordo?". E o publico mais quente que existe --
// colocou dinheiro e parou no meio.
//
// Quem ja tem acordo ativo fica de fora: nao e oportunidade, esta pagando as
// parcelas do acordo que ja existe. Eram 718 contra 71 -- sem esse corte a
// lista viraria ruido.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataCurta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

export default function PossivelAcordo() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [semDono, setSemDono] = useState(false);
  const [fichaId, setFichaId] = useState(null);
  const [nomeCopiado, setNomeCopiado] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    const { data, error } = await supabase.rpc("possivel_acordo");
    if (error) setErro(error.message);
    setLinhas(data || []);
    setCarregando(false);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const visiveis = useMemo(() => {
    let l = linhas;
    if (semDono) l = l.filter((x) => !x.responsavel_email);
    const t = busca.trim().toLowerCase();
    if (t) {
      const dig = t.replace(/\D/g, "");
      l = l.filter((x) =>
        String(x.nome || "").toLowerCase().includes(t) ||
        (dig && String(x.cpf || "").replace(/\D/g, "").includes(dig)));
    }
    return l;
  }, [linhas, busca, semDono]);

  const totalFalta = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.falta || 0), 0), [visiveis]);
  const totalPago = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.pago || 0), 0), [visiveis]);

  function copiarNome(nome) {
    navigator.clipboard.writeText(nome || "").then(() => {
      setNomeCopiado(nome);
      setTimeout(() => setNomeCopiado(""), 1500);
    });
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Possível acordo</h1>
          <p style={S.sub}>
            Pagou alguma coisa, ainda deve e não tem acordo. É quem já provou que quer
            resolver — só parou no meio.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={S.barra}>
        <input
          style={S.input}
          placeholder="Buscar por nome ou CPF..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={semDono} onChange={(e) => setSemDono(e.target.checked)} />
          Só os sem responsável
        </label>
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{visiveis.length} alunos</span>
          <span style={S.contadorAcordos}>já pagaram {moeda(totalPago)}</span>
          <span style={S.contadorValor}>falta {moeda(totalFalta)}</span>
        </div>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>Nenhum aluno nesta situação agora.</p>
      ) : null}

      <div style={S.cards}>
        {visiveis.map((l) => (
          <div key={l.aluno_id} style={S.card}>
            <div style={S.cardHead}>
              <div style={S.cardHeadInfo}>
                <span style={S.cardNome}>{l.nome}</span>
                <button
                  type="button"
                  onClick={() => copiarNome(l.nome)}
                  style={btnCopiar}
                  title="Copiar o nome do aluno"
                >
                  {nomeCopiado === l.nome ? "✓ Copiado" : "📋 Copiar"}
                </button>
                <span style={S.cardCpf}>
                  CPF {l.cpf || "-"} · {l.responsavel} · último pagamento {dataCurta(l.ultimo_pagamento)}
                  {l.dias_desde_pagamento != null ? ` (há ${l.dias_desde_pagamento} dias)` : ""}
                </span>
              </div>
              <div style={S.cardHeadDir}>
                <span style={seloPago}>já pagou {moeda(l.pago)}</span>
                <span style={seloFalta}>falta {moeda(l.falta)}</span>
                <button type="button" onClick={() => setFichaId(l.aluno_id)} style={S.btnFicha}>
                  Abrir ficha
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => { setFichaId(null); carregar(); }}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const btnCopiar = { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8, padding: "3px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" };
const seloPago = { fontSize: 12.5, fontWeight: 800, color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "4px 12px" };
const seloFalta = { fontSize: 12.5, fontWeight: 800, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999, padding: "4px 12px" };
