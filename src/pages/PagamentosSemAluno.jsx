// Fila de pagamentos sem aluno.
//
// POR QUE EXISTE. O extrato de pagamentos nao traz CPF, e ate 28/08/2026 a
// importacao tambem descartava a matricula (coluna B vem como
// "2026002333 - Nome"). Resultado: pagamento entrava sem nenhum vinculo com a
// base. O vinculo automatico casa pelo nome, mas SO quando o nome aparece uma
// unica vez em toda a base -- nome repetido nao entra, porque e exatamente ali
// que o casamento por nome erra (a base tem 109 nomes repetidos com CPFs
// diferentes).
//
// O que sobra cai aqui, com o motivo separado:
//   NOME_REPETIDO -> ha mais de um aluno com esse nome; a gestao escolhe
//   SEM_CADASTRO  -> nao existe aluno com esse nome; a gestao cria ou ignora
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import CadastroNovoAluno from "../components/CadastroNovoAluno";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataCurta(d) {
  if (!d) return "-";
  const [a, m, dia] = String(d).slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}
function mesAtual() {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}`;
}

export default function PagamentosSemAluno() {
  const [mes, setMes] = useState(mesAtual());
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [filtro, setFiltro] = useState("TODOS");
  const [abertoId, setAbertoId] = useState(null);
  const [fichaId, setFichaId] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("pagamentos_sem_aluno", { p_mes: mes });
    if (error) setErro(error.message);
    setLinhas(data || []);
    setCarregando(false);
  }, [mes]);

  useEffect(() => { carregar(); }, [carregar]);

  const visiveis = useMemo(
    () => (filtro === "TODOS" ? linhas : linhas.filter((l) => l.motivo === filtro)),
    [linhas, filtro],
  );
  const total = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.valor_pago || 0), 0),
    [visiveis],
  );
  const repetidos = linhas.filter((l) => l.motivo === "NOME_REPETIDO").length;
  const semCadastro = linhas.filter((l) => l.motivo === "SEM_CADASTRO").length;

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Pagamentos sem aluno</h1>
          <p style={S.sub}>
            O que o vínculo automático não resolveu. Nome repetido e aluno sem cadastro
            precisam da sua decisão — o valor já está no mês, só falta saber de quem é.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={S.barra}>
        <input
          type="month"
          value={mes}
          onChange={(e) => setMes(e.target.value)}
          style={S.select}
        />
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={S.select}>
          <option value="TODOS">Todos ({linhas.length})</option>
          <option value="NOME_REPETIDO">Nome repetido ({repetidos})</option>
          <option value="SEM_CADASTRO">Sem cadastro ({semCadastro})</option>
        </select>
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>{visiveis.length} pagamentos</span>
          <span style={S.contadorValor}>{moeda(total)}</span>
        </div>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>
          Nenhum pagamento pendente de vínculo neste mês. Tudo casado com aluno.
        </p>
      ) : null}

      <div style={S.cards}>
        {visiveis.map((l) => (
          <Linha
            key={l.pagamento_id}
            item={l}
            aberto={abertoId === l.pagamento_id}
            onAbrir={() => setAbertoId(abertoId === l.pagamento_id ? null : l.pagamento_id)}
            onVinculado={carregar}
            onVerFicha={setFichaId}
          />
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
                onClick={() => setFichaId(null)}
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

function Linha({ item, aberto, onAbrir, onVinculado, onVerFicha }) {
  const [termo, setTermo] = useState("");
  const [resultados, setResultados] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState("");

  const repetido = item.motivo === "NOME_REPETIDO";

  async function buscar() {
    const t = termo.trim();
    if (t.length < 3) { setMsg("Digite ao menos 3 letras ou o CPF."); return; }
    setBuscando(true); setMsg("");
    const { data, error } = await supabase.rpc("buscar_aluno", { p_termo: t });
    if (error) setMsg("Erro na busca: " + error.message);
    setResultados(data || []);
    setBuscando(false);
  }

  async function vincular(alunoId, nomeAluno) {
    if (!window.confirm(
      `Vincular o pagamento de ${moeda(item.valor_pago)} (${dataCurta(item.data_pagamento)}) ao aluno ${nomeAluno}?`
    )) return;
    setSalvando(true); setMsg("");
    const { data, error } = await supabase.rpc("pagamento_vincular_aluno", {
      p_pagamento_id: item.pagamento_id,
      p_aluno_id: alunoId,
      p_observacao: `Fila de pagamentos sem aluno (${item.motivo}).`,
    });
    setSalvando(false);
    if (error) { setMsg("Erro: " + error.message); return; }
    if (!data?.ok) { setMsg("Não foi possível: " + (data?.motivo || "desconhecido")); return; }
    onVinculado();
  }

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <div style={S.cardHeadInfo}>
          <span style={S.cardNome}>{item.aluno_nome || "(sem nome no arquivo)"}</span>
          <span style={S.cardCpf}>
            {dataCurta(item.data_pagamento)} · título {item.titulo_numero || "-"}
            {item.matricula ? ` · matrícula ${item.matricula}` : ""}
          </span>
        </div>
        <div style={S.cardHeadDir}>
          <span style={repetido ? selo.repetido : selo.semCadastro}>
            {repetido ? `${item.candidatos} alunos com esse nome` : "sem cadastro na base"}
          </span>
          <span style={S.contadorValor}>{moeda(item.valor_pago)}</span>
          <span style={S.cardCpf}>{item.operador_nome || "(sem operador)"}</span>
          <button type="button" onClick={onAbrir} style={S.btnGhost}>
            {aberto ? "Fechar" : "Resolver"}
          </button>
        </div>
      </div>

      {aberto ? (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") buscar(); }}
              placeholder="Buscar aluno por nome ou CPF"
              style={S.input}
            />
            <button type="button" onClick={buscar} style={S.btnGhost} disabled={buscando}>
              {buscando ? "Buscando…" : "Buscar"}
            </button>
            {item.motivo === "SEM_CADASTRO" ? (
              <CadastroNovoAluno
                onSucesso={(novo) => { if (novo?.id) vincular(novo.id, novo.nome || "novo cadastro"); }}
              />
            ) : null}
          </div>

          {msg ? <p style={{ ...S.muted, marginTop: 10 }}>{msg}</p> : null}

          {resultados ? (
            resultados.length === 0 ? (
              <p style={{ ...S.muted, marginTop: 10 }}>
                Nenhum aluno encontrado com esse termo.
              </p>
            ) : (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {resultados.slice(0, 12).map((a) => (
                  <div key={a.id} style={resultadoLinha}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "#0f172a", fontSize: 13.5 }}>{a.nome}</div>
                      <div style={S.cardCpf}>
                        CPF {a.cpf || "-"}
                        {a.responsavel_atual_nome ? ` · ${a.responsavel_atual_nome}` : " · sem responsável"}
                        {a.status_atual ? ` · ${a.status_atual}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => onVerFicha && onVerFicha(a.id)}
                        style={{ ...S.btnGhost, background: "#eef2ff", color: "#3730a3" }}
                        title="Conferir a ficha antes de vincular, sem sair da fila"
                      >
                        Ver ficha
                      </button>
                      <button
                        type="button"
                        onClick={() => vincular(a.id, a.nome)}
                        disabled={salvando}
                        style={S.btnGhost}
                      >
                        {salvando ? "…" : "Vincular"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const selo = {
  repetido: { fontSize: 12, fontWeight: 800, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999, padding: "4px 12px" },
  semCadastro: { fontSize: 12, fontWeight: 800, color: "#991b1b", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 999, padding: "4px 12px" },
};
const resultadoLinha = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
  border: "1px solid #e6eaf0", borderRadius: 10, padding: "10px 12px", background: "#f8fafc",
};
