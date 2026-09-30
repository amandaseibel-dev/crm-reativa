import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { ALVO_IDEIA, estruturaAusente, mensagemErroCurtida } from "./curtidas";
import { gravarCurtida } from "./useCurtidas";
import { ORDENS, SEM_IDEIAS, rotuloStatus } from "./ideias";

function dataCurta(valor) {
  if (!valor) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo",
  }).format(new Date(valor));
}

// Mural de ideias. A contagem de curtidas vem na propria RPC porque "mais
// curtidas" precisa ordenar no banco -- por isso este componente nao usa
// useCurtidas para ler, so para gravar.
export default function IdeiasEquipe({ usuario, Card, CabecalhoCard, S }) {
  const [ideias, setIdeias] = useState([]);
  const [ordem, setOrdem] = useState("curtidas");
  const [carregando, setCarregando] = useState(true);
  const [disponivel, setDisponivel] = useState(true);
  const [ocupado, setOcupado] = useState(null);

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
          <select
            value={ordem}
            onChange={(e) => setOrdem(e.target.value)}
            aria-label="Ordenar ideias"
            style={S.seletorOrdem}
          >
            {ORDENS.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
          </select>
        }
      />

      {ideias.length ? (
        <div style={S.listaIdeias}>
          {ideias.map((i) => (
            <div key={i.id} style={S.ideia}>
              <p style={S.ideiaTexto}>{i.descricao}</p>
              <div style={S.ideiaRodape}>
                <span style={S.ideiaAutor}>{i.autor || "Equipe"}</span>
                <span style={S.ideiaData}>{dataCurta(i.criado_em)}</span>
                <span style={S.ideiaStatus}>{rotuloStatus(i.status)}</span>
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
