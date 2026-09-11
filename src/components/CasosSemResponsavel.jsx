import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "../pages/Aluno";
import { Carregando } from "../ui/estados";
import { S as A } from "../ui/estilosFila";
import { podeAlterarOperadorProjecao } from "../utils/operadores";

// Caso com divida em aberto e SEM DONO -- nem em `casos.operador_email` nem em
// `alunos.responsavel_atual_email`.
//
// Regra da gestao (11/09/2026): "se nao tiver dono vai para fila sem
// responsavel". Ate entao so existia a fila de ACORDOS sem responsavel, e quem
// devia mensalidade ficava invisivel: dos 95 casos orfaos, 42 tinham so
// mensalidade e nao apareciam em tela nenhuma da operacao.
//
// Vincular aqui escreve em `alunos` pelo caminho oficial (internal.set_resp_aluno)
// e o gatilho espelha para `casos` -- nunca o contrario.
const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dia = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("pt-BR") : "nunca");

const POR_PAGINA = 50;

export default function CasosSemResponsavel({ aoAtualizarContagem }) {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [pessoas, setPessoas] = useState([]);
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [fichaId, setFichaId] = useState(null);
  const [escolha, setEscolha] = useState({});
  const [vinculando, setVinculando] = useState({});
  const [pagina, setPagina] = useState(0);
  const [busca, setBusca] = useState("");
  const [soMensalidade, setSoMensalidade] = useState(false);
  const [emailUsuario, setEmailUsuario] = useState("");
  const emVooRef = useRef(false);

  const podeVincular = podeAlterarOperadorProjecao(emailUsuario);

  const carregar = useCallback(async () => {
    if (emVooRef.current) return;
    emVooRef.current = true;
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("fila_casos_sem_responsavel");
    emVooRef.current = false;
    setCarregando(false);
    if (error) {
      setErro("Não foi possível carregar os casos sem responsável.");
      return;
    }
    setLista(data || []);
  }, []);

  useEffect(() => {
    // Carga unica ao montar -- a aba so monta quando esta ativa. O setState
    // acontece depois do await da RPC.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let vivo = true;
    supabase.auth.getUser().then(({ data }) => {
      if (vivo) setEmailUsuario(data?.user?.email || "");
    });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    let vivo = true;
    supabase
      .from("usuarios")
      .select("email, nome, perfil")
      .eq("ativo", true)
      .order("nome")
      .then(({ data }) => {
        // 'painel' e a TV, nao e pessoa. Em 10/09/2026 um acordo de R$ 236.929,17
        // foi vinculado ao "Painel TV" por engano, porque ele estava na lista.
        if (vivo && Array.isArray(data)) {
          setPessoas(data.filter((p) => p.perfil !== "painel"));
        }
      });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (aoAtualizarContagem) aoAtualizarContagem(lista.length);
  }, [lista, aoAtualizarContagem]);

  async function vincular(linha) {
    const email = escolha[linha.caso_id];
    if (!email) return;
    const pessoa = pessoas.find((p) => p.email === email);
    const ok = window.confirm(
      `Passar este caso para ${pessoa?.nome || email}?\n\n` +
        `${linha.aluno} — ${moeda(linha.total)} em aberto\n\n` +
        `O aluno entra na carteira dessa pessoa e volta para a fila de acionamento.`
    );
    if (!ok) return;

    setVinculando((s) => ({ ...s, [linha.caso_id]: true }));
    setAviso("");
    const { data, error } = await supabase.rpc("vincular_responsavel_caso", {
      p_aluno_ids: [linha.aluno_id],
      p_email: email,
    });
    setVinculando((s) => ({ ...s, [linha.caso_id]: false }));
    if (error) {
      setAviso("Não foi possível vincular: " + (error.message || ""));
      return;
    }
    if (!data?.vinculados) {
      setAviso("Este caso já tinha responsável — a lista foi atualizada.");
      carregar();
      return;
    }
    setAviso(`${linha.aluno}: caso passou para ${data.operador_nome}.`);
    setLista((l) => l.filter((x) => x.caso_id !== linha.caso_id));
  }

  const filtrada = useMemo(() => {
    const q = busca.trim().toLowerCase();
    let base = soMensalidade ? lista.filter((l) => !l.tem_acordo_ativo) : lista;
    if (q) {
      base = base.filter(
        (l) =>
          (l.aluno || "").toLowerCase().includes(q) ||
          (l.cpf || "").includes(q.replace(/\D/g, "")) ||
          (l.matricula || "").includes(q)
      );
    }
    return base;
  }, [lista, busca, soMensalidade]);

  const total = filtrada.reduce((t, l) => t + Number(l.total || 0), 0);
  const paginas = Math.max(1, Math.ceil(filtrada.length / POR_PAGINA));
  const p = Math.min(pagina, paginas - 1);
  const visiveis = filtrada.slice(p * POR_PAGINA, (p + 1) * POR_PAGINA);
  const soMens = lista.filter((l) => !l.tem_acordo_ativo).length;

  if (carregando && !lista.length) {
    return <Carregando texto="Carregando casos sem responsável…" />;
  }

  return (
    <div>
      <div style={A.topo}>
        <div>
          <h2 style={A.titulo}>Casos sem responsável</h2>
          <p style={A.sub}>
            Aluno com dívida em aberto e sem dono nenhum — não aparece na carteira
            de ninguém. Defina o responsável e ele volta para a fila de acionamento.
          </p>
        </div>
        <div style={A.contadores}>
          <span style={A.contadorAlunos}>{filtrada.length} casos</span>
          <span style={A.contadorValor}>{moeda(total)} em aberto</span>
          {soMens ? (
            <span style={A.contadorAcordos}>{soMens} só mensalidade</span>
          ) : null}
        </div>
      </div>

      <div style={A.barra}>
        <input
          type="search"
          value={busca}
          placeholder="Buscar por nome, CPF ou matrícula"
          onChange={(e) => { setBusca(e.target.value); setPagina(0); }}
          style={A.input}
        />
        <label style={{ ...A.muted, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={soMensalidade}
            onChange={(e) => { setSoMensalidade(e.target.checked); setPagina(0); }}
          />
          Só mensalidade (sem acordo)
        </label>
        <button type="button" style={A.btnGhost} onClick={carregar}>Atualizar</button>
        {paginas > 1 ? (
          <span style={A.muted}>
            <button type="button" style={A.btnGhostClaro} disabled={p === 0}
                    onClick={() => setPagina(p - 1)}>‹</button>
            {" "}página {p + 1} de {paginas}{" "}
            <button type="button" style={A.btnGhostClaro} disabled={p >= paginas - 1}
                    onClick={() => setPagina(p + 1)}>›</button>
          </span>
        ) : null}
      </div>

      {erro ? <div style={A.erroBox}>{erro}</div> : null}
      {aviso ? <div style={A.erroBox}>{aviso}</div> : null}
      {!podeVincular ? (
        <p style={A.muted}>
          Você pode consultar a lista. Definir o responsável é da Amanda e da Fernanda.
        </p>
      ) : null}

      {!filtrada.length ? (
        <p style={A.muted}>
          {busca || soMensalidade
            ? "Nenhum caso com esse filtro."
            : "Nenhum caso sem responsável. Todos têm dono."}
        </p>
      ) : (
        <div style={A.card}>
          <table style={A.tabela}>
            <thead>
              <tr>
                <th style={A.th}>Aluno</th>
                <th style={A.th}>CPF</th>
                <th style={A.thNum}>Mensalidade</th>
                <th style={A.thNum}>Acordo</th>
                <th style={A.thNum}>Total</th>
                <th style={A.th}>Semestre</th>
                <th style={A.th}>Últ. acionamento</th>
                <th style={A.th}>Passar para</th>
                <th style={A.th}></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.caso_id}>
                  <td style={A.td}>
                    {l.aluno || "—"}
                    {l.tem_acordo_ativo ? (
                      <span style={{ ...A.chip, ...A.chipPend, marginLeft: 8 }}>acordo ativo</span>
                    ) : null}
                  </td>
                  <td style={A.td}>{l.cpf || "—"}</td>
                  <td style={A.tdNum}>{moeda(l.mensalidade)}</td>
                  <td style={A.tdNum}>{moeda(l.acordo)}</td>
                  <td style={A.tdNum}>{moeda(l.total)}</td>
                  <td style={A.td}>{l.semestre_divida || "—"}</td>
                  <td style={A.td}>{dia(l.data_ultimo_acionamento)}</td>
                  <td style={A.td}>
                    <select
                      style={A.select}
                      disabled={!podeVincular}
                      value={escolha[l.caso_id] || ""}
                      onChange={(e) =>
                        setEscolha((x) => ({ ...x, [l.caso_id]: e.target.value }))
                      }
                    >
                      <option value="">Escolher…</option>
                      {pessoas.map((pe) => (
                        <option key={pe.email} value={pe.email}>{pe.nome}</option>
                      ))}
                    </select>
                  </td>
                  <td style={A.td}>
                    <div style={A.acoes}>
                      {l.aluno_id ? (
                        <button type="button" style={A.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                          Ficha
                        </button>
                      ) : null}
                      {podeVincular ? (
                        <button
                          type="button"
                          style={
                            vinculando[l.caso_id] || !escolha[l.caso_id]
                              ? { ...A.btnConf, ...A.btnBusy }
                              : A.btnConf
                          }
                          disabled={!!vinculando[l.caso_id] || !escolha[l.caso_id]}
                          onClick={() => vincular(l)}
                        >
                          Vincular
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fichaId ? (
        <div style={A.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={A.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={A.modalTopo}>
              <strong>Ficha do aluno</strong>
              <button type="button" style={A.btnGhostClaro} onClick={() => setFichaId(null)}>Fechar</button>
            </div>
            <div style={{ overflow: "auto" }}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
