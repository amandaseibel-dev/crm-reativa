// Monta o slide "Meta do Mês" dentro da MOLDURA real da TV (cabeçalho, palco e
// rodapé de tvUI), alimentado por uma fatia `mes` escrita à mão — o formato que
// tv_snapshot_calcular() entrega. Zero banco.
import { createRoot } from "react-dom/client";
import { Cabecalho, Rodape, Palco, T, AREA_SEGURA } from "../src/components/tv/tvUI";
import { CATALOGO_TELAS } from "../src/components/tv/tvTelas";

const CENARIO = new URLSearchParams(location.search).get("c") || "andamento";

const BASE = {
  recuperado: 1180400, honorarios: 70000, pagamentos_confirmados: 141,
  meta_empresa: 122000, meta_pct: 57.4, meta_falta: 52000, meta_atingida: false,
  dias_uteis_mes: 22, dias_uteis_transcorridos: 4, dias_uteis_restantes: 18,
  necessidade_diaria: 2889, proj_honorarios: 385000, proj_honorarios_pct: 315.6,
};
const CENARIOS = {
  andamento: BASE,
  atrasado: { ...BASE, honorarios: 31000, meta_pct: 25.4, meta_falta: 91000,
    dias_uteis_transcorridos: 16, dias_uteis_restantes: 6, necessidade_diaria: 15167,
    proj_honorarios: 42625, proj_honorarios_pct: 34.9 },
  batida: { ...BASE, honorarios: 140000, meta_pct: 114.8, meta_falta: 0, meta_atingida: true,
    necessidade_diaria: null, dias_uteis_restantes: 9, proj_honorarios: 237000, proj_honorarios_pct: 194.3 },
  sem_meta: { ...BASE, meta_empresa: 0, meta_pct: null, meta_falta: null },
};

const snap = { mes: CENARIOS[CENARIO] || BASE };
const tela = CATALOGO_TELAS.find((t) => t.id === "meta_do_mes");

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
    <Rodape geradoEm={new Date().toISOString()} indice={0} total={22} />
  </div>
);
