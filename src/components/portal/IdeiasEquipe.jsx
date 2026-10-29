import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { ALVO_IDEIA, estruturaAusente, mensagemErroCurtida } from "./curtidas";
import { gravarCurtida } from "./useCurtidas";
import {
  ORDENS, SEM_IDEIAS, AREAS, TIPO_IDEIA, TELA_IDEIA, LIMITE_DESCRICAO,
  rotuloStatus, validarIdeia,
} from "./ideias";

function dataCurta(valor) {
  if (!valor) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo",
  }).format(new Date(valor));
}

const VAZIO = { descricao: "", area: "Atendimento" };

// Mural de ideias VIVAS: o que a gestao liberou, mais as da propria pessoa, para
// ela acompanhar a avaliacao. Ideia ja implementada ou descartada nao aparece --
// isto e mural de ideia em avaliacao, nao historico de chamado do CRM.
//
// A contagem de curtidas vem na propria RPC porque "mais curtidas" precisa
// ordenar no banco -- por isso este componente nao usa useCurtidas para ler, so
// para gravar.
export default function IdeiasEquipe({ usuario, Card, CabecalhoCard, S }) {
  const [ideias, setIdeias] = useState([]);
  const [ordem, setOrdem] = useState("curtidas");
  const [carregando, setCarregando] = useState(true);
  const [disponivel, setDisponivel] = useState(true);
  const [ocupado, setOcupado] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState(VAZIO);
  const [enviando, setEnviando] = useState(false);

  const email = usuario?.email || "";

  const buscar = useCallback(
    () => supabase.rpc("portal_ideias_equipe", { p_ordem: ordem, p_limite: 12 }),
    [ordem],
  );

  const aplicar = useCallback(({ data, error }) => {
    setCarregando(false);
    if (error) {
      if (estruturaAusente(error)) { setDisponivel(false); return; }
      console.error("portal_ideias_equipe:", error);
      setIdeias([]);
      return;
    }
    setDisponivel(true);
    setIdeias(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    let vivo = true;
    buscar().then((res) => { if (vivo) aplicar(res); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  const recarregar = useCallback(async () => { aplicar(await buscar()); }, [buscar, aplicar]);

  // O envio entra no MESMO fluxo do Painel de Sugestoes: insert em `sugestoes`
  // pela policy sugestoes_insert, com autor_email proprio. A ideia nasce NOVA e
  // invisivel para a equipe -- quem decide publicar continua sendo a gestao.
  //
  // Sem `.select()` de proposito: RETURNING dispara a policy de SELECT de
  // sugestoes, que e so da gestao, e um operador comum levaria 42501 mesmo tendo
  // direito de inserir. A ideia reaparece pela RPC, que e SECURITY DEFINER.
  async function enviar(e) {
    e.preventDefault();
    if (!email) {
      alert("Sua sessão ainda não foi identificada. Atualize a página e tente novamente.");
      return;
    }
    const problema = validarIdeia(form);
    if (problema) { alert(problema); return; }

    setEnviando(true);
    const { error } = await supabase.from("sugestoes").insert({
      descricao: form.descricao.trim(),
      nome: usuario?.nome || null,
      autor_email: email,
      area: form.area,
      tipo: TIPO_IDEIA,
      tela: TELA_IDEIA,
      visivel_equipe: false,
    });
    setEnviando(false);

    if (error) {
      console.error("Erro ao enviar ideia:", error);
      if (error.code === "42501") alert("Sua conta não tem permissão para enviar ideia. Avise a gestão.");
      else if (estruturaAusente(error)) alert("O envio de ideias ainda não está ativado. Avise a gestão.");
      else alert(`Não foi possível enviar a ideia. Código: ${error.code || "sem código"}.`);
      return;
    }

    setForm(VAZIO);
    setAberto(false);
    await recarregar();
  }

  async function alternar(ideia) {
    if (!email) {
      alert("Sua sessão ainda não foi identificada. Atualize a página e tente novamente.");
      return;
    }
    setOcupado(ideia.id);
    const { error } = await gravarCurtida({
      alvoTipo: ALVO_IDEIA, alvoId: ideia.id, email, jaCurtida: ideia.eu_curti === true,
    });
    setOcupado(null);

    if (error) {
      console.error("Erro ao curtir ideia:", error);
      if (estruturaAusente(error)) { setDisponivel(false); return; }
      alert(mensagemErroCurtida(error, ideia.eu_curti === true));
    }
    await recarregar();
  }

  if (!disponivel) return null;

  return (
    <Card>
      <CabecalhoCard
        icone="💡"
        titulo="Ideias da equipe"
        acao={
          <div style={S.ideiasAcoes}>
            <select
              value={ordem}
              onChange={(e) => setOrdem(e.target.value)}
              aria-label="Ordenar ideias"
              style={S.seletorOrdem}
            >
              {ORDENS.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
            </select>
            <button type="button" onClick={() => setAberto((v) => !v)} style={S.botaoMini}>
              {aberto ? "Fechar" : "+ Minha ideia"}
            </button>
          </div>
        }
      />

      {aberto && (
        <form onSubmit={enviar} style={S.form}>
          <textarea
            value={form.descricao}
            onChange={(e) => setForm({ ...form, descricao: e.target.value })}
            placeholder="Qual é a sua ideia? Pode ser sobre atendimento, processos, operação ou ambiente de trabalho."
            maxLength={LIMITE_DESCRICAO}
            style={{ ...S.input, minHeight: 80, resize: "vertical" }}
          />
          <select value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} aria-label="Área da ideia" style={S.input}>
            {AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span style={S.mutedPequeno}>
            A ideia vai para a gestão avaliar. Você acompanha a sua aqui; a equipe vê depois que a gestão publicar.
          </span>
          <div style={S.formLinha}>
            <button disabled={enviando} style={S.botaoPrimario}>{enviando ? "Enviando..." : "Enviar ideia"}</button>
            <button type="button" onClick={() => { setAberto(false); setForm(VAZIO); }} style={S.botaoMini}>Cancelar</button>
          </div>
        </form>
      )}

      {ideias.length ? (
        <div style={S.listaIdeias}>
          {ideias.map((i) => (
            <div key={i.id} style={S.ideia}>
              <p style={S.ideiaTexto}>{i.descricao}</p>
              <div style={S.ideiaRodape}>
                <span style={S.ideiaAutor}>{i.autor || "Equipe"}</span>
                <span style={S.ideiaData}>{dataCurta(i.criado_em)}</span>
                <span style={S.ideiaStatus}>{rotuloStatus(i.status)}</span>
                {i.minha && <span style={S.ideiaMinha}>Sua ideia</span>}
                <span style={S.ideiaEspaco} />
                <button
                  type="button"
                  onClick={() => alternar(i)}
                  disabled={ocupado === i.id}
                  aria-pressed={i.eu_curti === true}
                  title={i.eu_curti ? "Retirar minha curtida" : "Curtir esta ideia"}
                  style={{ ...S.botaoCurtir, ...(i.eu_curti ? S.botaoCurtirAtivo : null) }}
                >
                  {i.eu_curti ? "❤️" : "🤍"} {i.curtidas ?? 0}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={S.muted}>{carregando ? "Buscando as ideias da equipe..." : SEM_IDEIAS}</p>
      )}
    </Card>
  );
}
