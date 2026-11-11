import AppKit

// Selected artwork: blue-gray #263B56, mint #64CBA0; three stops, Terra Max.
func c(_ value:UInt32,_ alpha:CGFloat=1)->NSColor {
    NSColor(srgbRed:CGFloat((value>>16)&255)/255,green:CGFloat((value>>8)&255)/255,
        blue:CGFloat(value&255)/255,alpha:alpha)
}
func rounded(_ r:NSRect,_ radius:CGFloat)->NSBezierPath {NSBezierPath(roundedRect:r,xRadius:radius,yRadius:radius)}
func fill(_ p:NSBezierPath,_ ink:NSColor){ink.setFill();p.fill()}
func canvas(_ width:Int,_ height:Int,_ draw:()->Void)->NSImage {
    let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:width,pixelsHigh:height,bitsPerSample:8,samplesPerPixel:4,
        hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    rep.size=NSSize(width:width,height:height);NSGraphicsContext.saveGraphicsState()
    let ctx=NSGraphicsContext(bitmapImageRep:rep)!;NSGraphicsContext.current=ctx
    ctx.shouldAntialias=true;ctx.imageInterpolation = .high;draw();NSGraphicsContext.restoreGraphicsState()
    let image=NSImage(size:rep.size);image.addRepresentation(rep);return image
}
struct Palette {
    let name:String
    let title:String
    let background:UInt32
    let active:UInt32
    let track:UInt32
    let primary:UInt32
    let secondary:UInt32
    let border:UInt32
    let activeDot:UInt32
    let inactiveDot:UInt32
    let thumbBorder:UInt32
}
func title(_ x:CGFloat,_ y:CGFloat,_ size:CGFloat,_ palette:Palette) {
    let text=NSMutableAttributedString(string:"Terra",attributes:[.font:NSFont.systemFont(ofSize:size,weight:.medium),.foregroundColor:c(palette.primary)])
    text.append(NSAttributedString(string:" Max",attributes:[.font:NSFont.systemFont(ofSize:size,weight:.regular),.foregroundColor:c(palette.secondary)]))
    let width=text.size().width
    text.draw(at:NSPoint(x:x-width/2,y:y))
}
func icon(_ palette:Palette)->NSImage {
canvas(1024,1024){
    fill(rounded(NSRect(x:62,y:62,width:900,height:900),198),c(palette.background))
    title(512,598,101,palette)
    let bolt=NSBezierPath()
    bolt.move(to:NSPoint(x:228,y:685));bolt.line(to:NSPoint(x:200,y:647))
    bolt.line(to:NSPoint(x:221,y:647));bolt.line(to:NSPoint(x:210,y:617))
    bolt.line(to:NSPoint(x:249,y:663));bolt.line(to:NSPoint(x:227,y:663))
    bolt.line(to:NSPoint(x:238,y:685));bolt.close()
    c(palette.secondary).setStroke();bolt.lineWidth=5;bolt.lineJoinStyle = .round;bolt.stroke()
    let chevron=NSBezierPath();chevron.move(to:NSPoint(x:785,y:665))
    chevron.line(to:NSPoint(x:803,y:647));chevron.line(to:NSPoint(x:785,y:629))
    c(palette.secondary).setStroke();chevron.lineWidth=6;chevron.lineCapStyle = .round;chevron.lineJoinStyle = .round;chevron.stroke()
    let track=rounded(NSRect(x:174,y:421,width:676,height:110),55)
    fill(track,c(palette.track));c(palette.border).setStroke();track.lineWidth=1.8;track.stroke()
    NSGraphicsContext.saveGraphicsState();track.addClip()
    fill(NSBezierPath(rect:NSRect(x:174,y:421,width:338,height:110)),c(palette.active))
    NSGraphicsContext.restoreGraphicsState()
    for x in [CGFloat(234),CGFloat(512),CGFloat(790)] {
        fill(NSBezierPath(ovalIn:NSRect(x:x-9,y:467,width:18,height:18)),x<512 ? c(palette.activeDot,0.8) : c(palette.inactiveDot,0.85))
    }
    let thumb=NSBezierPath(ovalIn:NSRect(x:449,y:413,width:126,height:126))
    fill(thumb,c(0xFFFFFF));c(palette.thumbBorder).setStroke();thumb.lineWidth=1.5;thumb.stroke()
}
}
let palette=Palette(name:"mint",title:"Codex Slider",background:0x263B56,active:0x64CBA0,track:0x34465C,
    primary:0xF0F5FC,secondary:0x99A8BA,border:0x42566F,activeDot:0xC0F7DB,inactiveDot:0x8092A7,thumbBorder:0xDBE7F6)
let image=icon(palette)
let bitmap=image.representations.first as! NSBitmapImageRep
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
