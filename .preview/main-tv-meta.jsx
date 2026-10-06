// Monta os slides "Meta do Mês" e "Magic Number" dentro da MOLDURA real da TV
// (cabeçalho, palco e rodapé de tvUI), alimentados por uma fatia de snapshot
// escrita à mão — o formato que tv_snapshot_atualizar() entrega. Zero banco.
//
// Valores de outubro/2026 combinados pela gestão: piso R$ 122.400,00 e Magic
// R$ 142.800,00. O Magic NÃO é múltiplo do piso (x 1,5 daria R$ 183.600,00).
import { createRoot } from "react-dom/client";
import { Cabecalho, Rodape, Palco, T, AREA_SEGURA } from "../src/components/tv/tvUI";
import { CATALOGO_TELAS } from "../src/components/tv/tvTelas";

const params = new URLSearchParams(location.search);
const CENARIO = params.get("c") || "andamento";
const SLIDE = params.get("t") || "meta_do_mes";

const BASE = {
  recuperado: 1180400, honorarios: 70000, pagamentos_confirmados: 141,
  meta_empresa: 122400, meta_pct: 57.2, meta_falta: 52400, meta_atingida: false,
  dias_uteis_mes: 22, dias_uteis_transcorridos: 4, dias_uteis_restantes: 18,
  necessidade_diaria: 2911, proj_honorarios: 385000, proj_honorarios_pct: 314.5,
};
const CENARIOS = {
  andamento: BASE,
  atrasado: { ...BASE, honorarios: 31000, meta_pct: 25.3, meta_falta: 91400,
    dias_uteis_transcorridos: 16, dias_uteis_restantes: 6, necessidade_diaria: 15233,
    proj_honorarios: 42625, proj_honorarios_pct: 34.8 },
  batida: { ...BASE, honorarios: 150000, meta_pct: 122.5, meta_falta: 0, meta_atingida: true,
    necessidade_diaria: null, dias_uteis_restantes: 9, proj_honorarios: 237000, proj_honorarios_pct: 193.6 },
  sem_meta: { ...BASE, meta_empresa: 0, meta_pct: null, meta_falta: null },
};

const snap = {
  mes: CENARIOS[CENARIO] || BASE,
  // chave mesclada por tv_snapshot_atualizar a partir de magic_number_mensal
  magic: CENARIO === "sem_magic" ? null : { mes_referencia: "2026-10", valor: 142800 },
};
const tela = CATALOGO_TELAS.find((t) => t.id === SLIDE) || CATALOGO_TELAS.find((t) => t.id === "meta_do_mes");

const raiz = {
  height: "100vh", width: "100vw", background: T.bg, color: T.texto,
  fontFamily: "Inter, system-ui, Arial, sans-serif", display: "flex", flexDirection: "column",
  padding: AREA_SEGURA, boxSizing: "border-box", overflow: "hidden", position: "relative",
};

createRoot(document.getElementById("raiz")).render(
  <div style={raiz}>
    <Cabecalho tela={tela.nome} />
    <Palco chave="preview">
      <tela.Comp snap={snap} />
    </Palco>
    <Rodape geradoEm={new Date().toISOString()} indice={0} total={23} />
  </div>
);
