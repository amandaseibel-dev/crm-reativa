import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { estruturaAusente, curtidasDe } from "./curtidas";

export const SEM_ELOGIOS = "Ainda não há elogios publicados para o mural.";

function dataCurta(valor) {
  if (!valor) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo",
  }).format(new Date(valor));
}

// Mural coletivo de reconhecimento. A fonte e elogios_atendimento, lida pela RPC
// portal_mural_elogios, que devolve so id, texto, operador e data -- print,
// observacao interna, motivo de rejeicao e e-mails nao chegam nem aqui.
//
// Reconhecimento, nao competicao: nao ha total por operador, nem ordenacao por
// quem tem mais elogios. A ordem e cronologica.
export default function MuralElogios({ usuario, curtidas, Card, CabecalhoCard, S }) {
  const [elogios, setElogios] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [disponivel, setDisponivel] = useState(true);

  const email = usuario?.email || "";

  const buscar = useCallback(() => supabase.rpc("portal_mural_elogios", { p_limite: 12 }), []);

  const aplicar = useCallback(({ data, error }) => {
    setCarregando(false);
    if (error) {
      if (estruturaAusente(error)) { setDisponivel(false); return; }
      console.error("portal_mural_elogios:", error);
      setElogios([]);
      return;
    }
    setDisponivel(true);
    setElogios(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    let vivo = true;
    buscar().then((res) => { if (vivo) aplicar(res); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  if (!disponivel) return null;

  return (
    <Card>
      <CabecalhoCard icone="⭐" titulo="Elogios da equipe" />

      {elogios.length ? (
        <div style={S.listaElogios}>
          {elogios.map((e) => {
            const c = curtidasDe(curtidas?.mapa, e.id);
            return (
              <div key={e.id} style={S.elogio}>
                <blockquote style={S.elogioTexto}>{e.texto}</blockquote>
                <div style={S.elogioRodape}>
                  <span style={S.elogioQuem}>{e.operador_nome}</span>
                  <span style={S.elogioData}>{dataCurta(e.publicado_em)}</span>
                  {curtidas?.disponivel && (
                    <button
                      type="button"
                      onClick={() => curtidas.alternar(e.id, email)}
                      disabled={curtidas.ocupado === e.id}
                      aria-pressed={c.euCurti}
                      title={c.euCurti ? "Retirar minha curtida" : "Curtir este elogio"}
                      style={{ ...S.botaoCurtir, ...(c.euCurti ? S.botaoCurtirAtivo : null) }}
                    >
                      {c.euCurti ? "❤️" : "🤍"} {c.curtidas}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p style={S.muted}>{carregando ? "Buscando os elogios da equipe..." : SEM_ELOGIOS}</p>
      )}
    </Card>
  );
}
